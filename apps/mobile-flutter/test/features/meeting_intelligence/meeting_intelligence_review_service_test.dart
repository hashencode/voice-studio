import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_review_service.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test('draft must be reviewed before evidence-backed publication', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = MeetingIntelligenceReviewService(repository: repository);
    final provider = FixtureMeetingIntelligenceProvider(
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.decision,
            body: 'Ship.',
            evidence: <MeetingEvidenceCandidate>[
              MeetingEvidenceCandidate(
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
      boundary: MeetingIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    final insightId = bundle.insights.single.id;

    expect(() => service.publish(insightId), throwsStateError);
    await service.markReviewed(insightId);
    await service.publish(insightId);
    expect(
      (await repository.findInsight(insightId))?.status,
      MeetingInsightStatus.published,
    );
    expect((await repository.listRevisions(bundle.note.id)).length, 2);
  });

  test('unsupported item can be reviewed but cannot publish', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = MeetingIntelligenceReviewService(repository: repository);
    final provider = FixtureMeetingIntelligenceProvider(
      output: const MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.summary,
            body: 'No evidence.',
          ),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: MeetingIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    final insightId = bundle.insights.single.id;
    await service.markReviewed(insightId);
    expect(() => service.publish(insightId), throwsStateError);
  });

  test('deleted source segment invalidates publication', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = MeetingIntelligenceReviewService(repository: repository);
    final provider = FixtureMeetingIntelligenceProvider(
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.risk,
            body: 'Risk.',
            evidence: <MeetingEvidenceCandidate>[
              MeetingEvidenceCandidate(
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
      boundary: MeetingIntelligenceProviderBoundary(provider: provider),
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
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final service = MeetingIntelligenceReviewService(repository: repository);
    final provider = FixtureMeetingIntelligenceProvider(
      output: const MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.summary,
            body: 'Draft.',
          ),
        ],
      ),
    );
    final bundle = await service.generateDraft(
      boundary: MeetingIntelligenceProviderBoundary(provider: provider),
      request: fixture.request,
    );
    await service.reject(bundle.insights.single.id);
    expect(
      (await repository.findInsight(bundle.insights.single.id))?.status,
      MeetingInsightStatus.rejected,
    );
  });

  test(
    'editing a published action returns it to draft with metadata revision',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = MeetingIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final service = MeetingIntelligenceReviewService(repository: repository);
      final provider = FixtureMeetingIntelligenceProvider(
        output: MeetingIntelligenceOutput(
          items: <MeetingInsightCandidate>[
            MeetingInsightCandidate(
              kind: MeetingInsightKind.action,
              body: 'Prepare rollout.',
              actionOwner: 'Alice',
              actionDueAtMs: 100,
              evidence: <MeetingEvidenceCandidate>[
                MeetingEvidenceCandidate(
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
        boundary: MeetingIntelligenceProviderBoundary(provider: provider),
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
      expect(edited.status, MeetingInsightStatus.draft);
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
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = MeetingIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final service = MeetingIntelligenceReviewService(repository: repository);
      final provider = FixtureMeetingIntelligenceProvider(
        output: MeetingIntelligenceOutput(
          suggestedTitle: 'S3 周会',
          items: <MeetingInsightCandidate>[
            MeetingInsightCandidate(
              kind: MeetingInsightKind.risk,
              body: 'Model contract may change.',
              evidence: <MeetingEvidenceCandidate>[
                MeetingEvidenceCandidate(
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
        boundary: MeetingIntelligenceProviderBoundary(provider: provider),
        request: fixture.request,
      );

      await service.setResolved(bundle.insights.single.id, resolved: true);
      await service.applySuggestedTitle(noteId: bundle.note.id, title: 'S3 周会');

      expect(
        (await repository.findInsight(
          bundle.insights.single.id,
        ))!.resolutionState,
        MeetingInsightResolutionState.resolved,
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
