import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';

import 'recording_test_database.dart';

void main() {
  test(
    'migration adds consent, session ownership, and recovery schema',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);

      final List<Map<String, Object?>> recordingColumns = await fixture.database
          .rawQuery('PRAGMA table_info(recordings)');
      final List<Map<String, Object?>> settingColumns = await fixture.database
          .rawQuery('PRAGMA table_info(app_settings)');
      final List<Map<String, Object?>> sessionTables = await fixture.database
          .rawQuery(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name = 'recording_sessions'",
          );

      expect(
        recordingColumns.map((row) => row['name']),
        contains('session_id'),
      );
      expect(
        settingColumns.map((row) => row['name']),
        containsAll(<String>[
          'recording_consent_version',
          'recording_consent_accepted_at_ms',
        ]),
      );
      expect(sessionTables, hasLength(1));

      await AppDatabase.migrateRecordingSessions(fixture.database);
    },
  );

  test('completed session commit is idempotent by session id', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = RecordingSessionsRepository(
      database: fixture.appDatabase,
    );
    const RecorderResult result = RecorderResult(
      sessionId: 'session-1',
      path: '/private/recording-1.m4a',
      durationMs: 8_000,
      stopReason: 'user_stop',
    );

    final int firstId = await repository.commitCompleted(
      result,
      enqueueTranscription: true,
    );
    final int secondId = await repository.commitCompleted(
      result,
      enqueueTranscription: true,
    );
    final List<Map<String, Object?>> recordings = await fixture.database.query(
      'recordings',
    );
    final List<Map<String, Object?>> sessions = await fixture.database.query(
      'recording_sessions',
    );
    final List<Map<String, Object?>> jobs = await fixture.database.query(
      'transcription_jobs',
    );

    expect(secondId, firstId);
    expect(recordings, hasLength(1));
    expect(sessions, hasLength(1));
    expect(sessions.single['recording_id'], firstId);
    expect(sessions.single['state'], 'completed');
    expect(jobs, hasLength(1));
    expect(jobs.single['status'], 'pending');
  });

  test('snapshot upsert preserves the original creation time', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = RecordingSessionsRepository(
      database: fixture.appDatabase,
    );

    await repository.upsertSnapshot(
      const RecordingSessionSnapshot(
        sessionId: 'session-2',
        state: 'recording',
        durationMs: 1_000,
        createdAtMs: 100,
        updatedAtMs: 200,
      ),
    );
    await repository.upsertSnapshot(
      const RecordingSessionSnapshot(
        sessionId: 'session-2',
        state: 'paused',
        durationMs: 2_000,
        createdAtMs: 100,
        updatedAtMs: 300,
      ),
    );

    final row = (await fixture.database.query(
      'recording_sessions',
      where: 'session_id = ?',
      whereArgs: <Object>['session-2'],
    )).single;
    expect(row['state'], 'paused');
    expect(row['duration_ms'], 2_000);
    expect(row['created_at_ms'], 100);
    expect(row['native_updated_at_ms'], 300);
  });
}
