import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_repository.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_validator.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test(
    'persists typed insights, evidence, unresolved fields and revisions',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = AudioIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final provider = FixtureAudioIntelligenceProvider(
        output: AudioIntelligenceOutput(
          items: <AudioInsightCandidate>[
            AudioInsightCandidate(
              kind: AudioInsightKind.decision,
              body: 'Ship.',
              evidence: <AudioEvidenceCandidate>[
                AudioEvidenceCandidate(
                  segmentId: fixture.segment.id,
                  startMs: 1200,
                  endMs: 3000,
                ),
              ],
            ),
            const AudioInsightCandidate(
              kind: AudioInsightKind.action,
              body: 'Prepare rollout.',
            ),
          ],
        ),
      );
      final validated = const AudioIntelligenceValidator().validate(
        request: fixture.request,
        output: provider.output,
      );

      final bundle = await repository.createDraft(
        provider: provider,
        request: fixture.request,
        validated: validated,
      );
      expect(bundle.insights.length, 2);
      expect(
        bundle.evidenceByInsight.values.expand((value) => value).length,
        1,
      );
      final action = bundle.insights.singleWhere(
        (item) => item.kind == AudioInsightKind.action,
      );
      expect(action.unresolvedOwner, isTrue);
      expect(action.unresolvedDueDate, isTrue);
      expect(action.unsupported, isTrue);

      await repository.editInsight(
        insightId: action.id,
        body: 'Prepare a safe rollout.',
      );
      final revisions = await repository.listRevisions(bundle.note.id);
      expect(revisions.single.previousBody, 'Prepare rollout.');
      expect(revisions.single.nextBody, 'Prepare a safe rollout.');
    },
  );

  test('audio deletion cascades all intelligence rows', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final provider = FixtureAudioIntelligenceProvider(
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.summary,
            body: 'Summary.',
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
    await repository.createDraft(
      provider: provider,
      request: fixture.request,
      validated: const AudioIntelligenceValidator().validate(
        request: fixture.request,
        output: provider.output,
      ),
    );

    await RecordingsRepository(database: fixture.appDatabase).deleteAudioGraph(
      recordingId: fixture.recordingId,
      recordingPath: '/intelligence.m4a',
    );

    for (final table in <String>[
      'audio_notes',
      'audio_insights',
      'evidence_links',
      'audio_note_revisions',
    ]) {
      final rows = await fixture.database.rawQuery(
        'SELECT COUNT(*) AS count FROM $table',
      );
      expect(rows.single['count'], 0, reason: table);
    }
  });
}
