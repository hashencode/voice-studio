import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_repository.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_review_service.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test('draft must be reviewed before evidence-backed publication', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = AudioIntelligenceReviewService(repository: repository);
    final provider = FixtureAudioIntelligenceProvider(
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.decision,
            body: 'Ship.',
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1000,
                endMs: 4000,
              ),
            ],
          ),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: AudioIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    final insightId = bundle.insights.single.id;

    expect(() => service.publish(insightId), throwsStateError);
    await service.markReviewed(insightId);
    await service.publish(insightId);
    expect(
      (await repository.findInsight(insightId))?.status,
      AudioInsightStatus.published,
    );
    expect((await repository.listRevisions(bundle.note.id)).length, 2);
  });

  test('unsupported item can be reviewed but cannot publish', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = AudioIntelligenceReviewService(repository: repository);
    final provider = FixtureAudioIntelligenceProvider(
      output: const AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.summary,
            body: 'No evidence.',
          ),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: AudioIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    final insightId = bundle.insights.single.id;
    await service.markReviewed(insightId);
    expect(() => service.publish(insightId), throwsStateError);
  });

  test('deleted source segment invalidates publication', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = AudioIntelligenceReviewService(repository: repository);
    final provider = FixtureAudioIntelligenceProvider(
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.risk,
            body: 'Risk.',
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1000,
                endMs: 2000,
              ),
            ],
          ),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: AudioIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    final insightId = bundle.insights.single.id;
    await service.markReviewed(insightId);
    await fixture.database.delete(
      'transcript_segments',
      where: 'id = ?',
      whereArgs: <Object>[fixture.segment.id],
    );
    expect(() => service.publish(insightId), throwsStateError);
  });

  test('reject transition is explicit and persisted', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = AudioIntelligenceReviewService(repository: repository);
    final provider = FixtureAudioIntelligenceProvider(
      output: const AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(kind: AudioInsightKind.summary, body: 'Draft.'),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: AudioIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    await service.reject(bundle.insights.single.id);
    expect(
      (await repository.findInsight(bundle.insights.single.id))?.status,
      AudioInsightStatus.rejected,
    );
  });

  test(
    'editing a published action returns it to draft with metadata revision',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = AudioIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final service = AudioIntelligenceReviewService(repository: repository);
      final provider = FixtureAudioIntelligenceProvider(
        output: AudioIntelligenceOutput(
          items: <AudioInsightCandidate>[
            AudioInsightCandidate(
              kind: AudioInsightKind.action,
              body: 'Prepare rollout.',
              actionOwner: 'Alice',
              actionDueAtMs: 100,
              evidence: <AudioEvidenceCandidate>[
                AudioEvidenceCandidate(
                  segmentId: fixture.segment.id,
                  startMs: 1000,
                  endMs: 2000,
                ),
              ],
            ),
          ],
        ),
      );
      final bundle = await service.generateDraft(
        boundary: AudioIntelligenceProviderBoundary(provider: provider),
        request: fixture.request,
      );
      final id = bundle.insights.single.id;
      await service.markReviewed(id);
      await service.publish(id);

      await service.edit(
        insightId: id,
        body: 'Prepare staged rollout.',
        clearActionOwner: true,
        clearActionDueAt: true,
      );

      final edited = (await repository.findInsight(id))!;
      expect(edited.status, AudioInsightStatus.draft);
      expect(edited.body, 'Prepare staged rollout.');
      expect(edited.actionOwner, isNull);
      expect(edited.actionDueAtMs, isNull);
      expect(edited.unresolvedOwner, isTrue);
      expect(edited.unresolvedDueDate, isTrue);
      expect(
        (await repository.listRevisions(
          bundle.note.id,
        )).map((revision) => revision.action),
        contains('edit'),
      );
    },
  );

  test(
    'risk resolution and explicit title application are revisioned',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = AudioIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final service = AudioIntelligenceReviewService(repository: repository);
      final provider = FixtureAudioIntelligenceProvider(
        output: AudioIntelligenceOutput(
          suggestedTitle: 'S3 周会',
          items: <AudioInsightCandidate>[
            AudioInsightCandidate(
              kind: AudioInsightKind.risk,
              body: 'Model contract may change.',
              evidence: <AudioEvidenceCandidate>[
                AudioEvidenceCandidate(
                  segmentId: fixture.segment.id,
                  startMs: 1000,
                  endMs: 2000,
                ),
              ],
            ),
          ],
        ),
      );
      final bundle = await service.generateDraft(
        boundary: AudioIntelligenceProviderBoundary(provider: provider),
        request: fixture.request,
      );

      await service.setResolved(bundle.insights.single.id, resolved: true);
      await service.applySuggestedTitle(noteId: bundle.note.id, title: 'S3 周会');

      expect(
        (await repository.findInsight(
          bundle.insights.single.id,
        ))!.resolutionState,
        AudioInsightResolutionState.resolved,
      );
      final recording = await fixture.database.query(
        'recordings',
        columns: <String>['display_name'],
        where: 'id = ?',
        whereArgs: <Object>[fixture.recordingId],
      );
      expect(recording.single['display_name'], 'S3 周会');
      expect(
        (await repository.listRevisions(
          bundle.note.id,
        )).map((revision) => revision.action),
        containsAll(<String>['resolve', 'apply_title']),
      );
    },
  );
}
