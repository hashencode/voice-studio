import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_validator.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test(
    'persists typed insights, evidence, unresolved fields and revisions',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = MeetingIntelligenceRepository(
        database: fixture.appDatabase,
      );
      final provider = FixtureMeetingIntelligenceProvider(
        output: MeetingIntelligenceOutput(
          items: <MeetingInsightCandidate>[
            MeetingInsightCandidate(
              kind: MeetingInsightKind.decision,
              body: 'Ship.',
              evidence: <MeetingEvidenceCandidate>[
                MeetingEvidenceCandidate(
                  segmentId: fixture.segment.id,
                  startMs: 1200,
                  endMs: 3000,
                ),
              ],
            ),
            const MeetingInsightCandidate(
              kind: MeetingInsightKind.action,
              body: 'Prepare rollout.',
            ),
          ],
        ),
      );
      final validated = const MeetingIntelligenceValidator().validate(
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
        (item) => item.kind == MeetingInsightKind.action,
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

  test('meeting deletion cascades all intelligence rows', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final provider = FixtureMeetingIntelligenceProvider(
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.summary,
            body: 'Summary.',
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
    await repository.createDraft(
      provider: provider,
      request: fixture.request,
      validated: const MeetingIntelligenceValidator().validate(
        request: fixture.request,
        output: provider.output,
      ),
    );

    await RecordingsRepository(
      database: fixture.appDatabase,
    ).deleteMeetingGraph(
      recordingId: fixture.recordingId,
      recordingPath: '/intelligence.m4a',
    );

    for (final table in <String>[
      'meeting_notes',
      'meeting_insights',
      'evidence_links',
      'meeting_note_revisions',
    ]) {
      final rows = await fixture.database.rawQuery(
        'SELECT COUNT(*) AS count FROM $table',
      );
      expect(rows.single['count'], 0, reason: table);
    }
  });
}
