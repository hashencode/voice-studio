import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/model/recording_annotation_entity.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_annotations_repository.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import 'recording_test_database.dart';

void main() {
  test(
    'markers and note survive recording completion and transcription failure',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final annotations = RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      );
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);

      await sessions.upsertSnapshot(
        const RecordingSessionSnapshot(
          sessionId: 'annotated-session',
          state: 'recording',
          durationMs: 1_000,
        ),
      );
      await annotations.addMarker(
        sessionId: 'annotated-session',
        positionMs: 1_200,
      );
      await annotations.addMarker(
        sessionId: 'annotated-session',
        positionMs: 3_400,
      );
      await annotations.saveNote(
        sessionId: 'annotated-session',
        positionMs: 2_000,
        text: '  跟进预算  ',
      );

      final recordingId = await sessions.commitCompleted(
        const RecorderResult(
          sessionId: 'annotated-session',
          path: '/private/annotated-session.m4a',
          durationMs: 5_000,
        ),
        enqueueTranscription: true,
      );
      final job = await jobs.claimNextPending();
      await jobs.fail(
        id: job!.id,
        stage: 'recognizing',
        code: 'MODEL_FAILED',
        message: '模型失败',
      );

      final reopened = RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      );
      final items = await reopened.listForRecording(recordingId);

      expect(items, hasLength(3));
      expect(
        items.where((item) => item.kind == RecordingAnnotationKind.marker),
        hasLength(2),
      );
      expect(
        items
            .singleWhere((item) => item.kind == RecordingAnnotationKind.note)
            .text,
        '跟进预算',
      );
      expect(items.map((item) => item.positionMs), <int>[1_200, 2_000, 3_400]);
    },
  );

  test(
    'saving a note updates the single durable note and blank text clears it',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final annotations = RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      );
      await sessions.upsertSnapshot(
        const RecordingSessionSnapshot(
          sessionId: 'note-session',
          state: 'recording',
          durationMs: 0,
        ),
      );

      await annotations.saveNote(
        sessionId: 'note-session',
        positionMs: 500,
        text: '第一版',
      );
      await annotations.saveNote(
        sessionId: 'note-session',
        positionMs: 2_000,
        text: '第二版',
      );

      var items = await annotations.listForSession('note-session');
      expect(items, hasLength(1));
      expect(items.single.text, '第二版');
      expect(items.single.positionMs, 500);

      await annotations.saveNote(
        sessionId: 'note-session',
        positionMs: 3_000,
        text: '   ',
      );
      items = await annotations.listForSession('note-session');
      expect(items, isEmpty);
    },
  );

  test(
    'annotations require an existing session and non-negative position',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final annotations = RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      );

      await expectLater(
        annotations.addMarker(sessionId: 'missing', positionMs: 10),
        throwsA(isA<StateError>()),
      );
      await expectLater(
        annotations.addMarker(sessionId: 'missing', positionMs: -1),
        throwsA(isA<ArgumentError>()),
      );
    },
  );
}
