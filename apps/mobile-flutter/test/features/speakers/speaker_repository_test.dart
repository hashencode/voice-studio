import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/speakers/model/speaker_turn_entity.dart';
import 'package:voice2text_flutter/features/speakers/repository/speaker_repository.dart';

import '../meeting_intelligence/meeting_intelligence_test_fixture.dart';

void main() {
  test('persists anonymous turns, assignments and rename revision', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = SpeakerRepository(database: fixture.appDatabase);

    await repository.replaceAutomaticResult(
      recordingId: fixture.recordingId,
      generationId: fixture.generationId,
      turns: const <SpeakerTurnDraft>[
        SpeakerTurnDraft(
          stableSpeakerKey: 'cluster-0',
          startMs: 1000,
          endMs: 2500,
          confidence: 0.8,
        ),
        SpeakerTurnDraft(
          stableSpeakerKey: 'cluster-1',
          startMs: 2500,
          endMs: 4000,
        ),
      ],
      assignments: <SpeakerAssignmentDraft>[
        SpeakerAssignmentDraft(
          segmentId: fixture.segment.id,
          stableSpeakerKey: 'cluster-0',
          startMs: 1000,
          endMs: 2500,
          state: SpeakerAssignmentState.assigned,
        ),
        SpeakerAssignmentDraft(
          segmentId: fixture.segment.id,
          startMs: 2500,
          endMs: 4000,
          state: SpeakerAssignmentState.overlap,
        ),
      ],
    );

    final speakers = await repository.listSpeakers(fixture.generationId);
    final turns = await repository.listTurns(fixture.generationId);
    final assignments = await repository.listAssignments(fixture.generationId);
    expect(speakers.map((speaker) => speaker.displayName), <String>[
      '说话人 1',
      '说话人 2',
    ]);
    expect(turns, hasLength(2));
    expect(assignments, hasLength(2));
    expect(assignments.last.state, SpeakerAssignmentState.overlap);
    expect(assignments.last.speakerId, isNull);

    await repository.renameSpeaker(
      speakerId: speakers.first.id,
      displayName: '主持人',
    );
    expect(
      (await repository.listSpeakers(fixture.generationId)).first.displayName,
      '主持人',
    );
    final revisions = await fixture.database.query('speaker_revisions');
    expect(revisions, hasLength(1));
    expect(revisions.single['action'], 'rename');
  });

  test('invalid automatic result rolls back atomically', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = SpeakerRepository(database: fixture.appDatabase);

    expect(
      () => repository.replaceAutomaticResult(
        recordingId: fixture.recordingId,
        generationId: fixture.generationId,
        turns: const <SpeakerTurnDraft>[
          SpeakerTurnDraft(
            stableSpeakerKey: 'cluster-0',
            startMs: 3000,
            endMs: 2000,
          ),
        ],
        assignments: const <SpeakerAssignmentDraft>[],
      ),
      throwsArgumentError,
    );
    expect(await repository.listSpeakers(fixture.generationId), isEmpty);
    expect(await repository.listTurns(fixture.generationId), isEmpty);
  });

  test('recording deletion cascades speaker graph', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final repository = SpeakerRepository(database: fixture.appDatabase);
    await repository.replaceAutomaticResult(
      recordingId: fixture.recordingId,
      generationId: fixture.generationId,
      turns: const <SpeakerTurnDraft>[
        SpeakerTurnDraft(
          stableSpeakerKey: 'cluster-0',
          startMs: 1000,
          endMs: 4000,
        ),
      ],
      assignments: <SpeakerAssignmentDraft>[
        SpeakerAssignmentDraft(
          segmentId: fixture.segment.id,
          stableSpeakerKey: 'cluster-0',
          startMs: 1000,
          endMs: 4000,
          state: SpeakerAssignmentState.assigned,
        ),
      ],
    );

    await fixture.database.delete(
      'recordings',
      where: 'id = ?',
      whereArgs: <Object>[fixture.recordingId],
    );
    for (final table in <String>[
      'meeting_speakers',
      'speaker_turns',
      'transcript_speaker_assignments',
      'speaker_revisions',
    ]) {
      expect(await fixture.database.query(table), isEmpty, reason: table);
    }
  });
}
