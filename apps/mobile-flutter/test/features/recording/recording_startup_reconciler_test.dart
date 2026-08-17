import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/recording/service/recording_startup_reconciler.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';

import 'recording_test_database.dart';

void main() {
  test(
    'startup reconciliation commits notification-stopped recording',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      var queueChangeCount = 0;
      final reconciler = RecordingStartupReconciler(
        recorder: _StartupRecorder(),
        sessionsRepository: sessions,
        settingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
        onQueueChanged: () => queueChangeCount += 1,
      );

      await reconciler.reconcile();
      await reconciler.reconcile();

      final recordings = await fixture.database.query(
        'recordings',
        where: 'session_id = ?',
        whereArgs: <Object>['startup-session'],
      );
      expect(recordings, hasLength(1));
      expect(recordings.single['duration_ms'], 15_808);
      final session = await sessions.findBySessionId('startup-session');
      expect(session?.state, 'completed');
      expect(session?.stopReason, 'notification_stop');
      expect(session?.recordingId, recordings.single['id']);
      final jobs = await fixture.database.query(
        'transcription_jobs',
        where: 'recording_path = ?',
        whereArgs: <Object>['/recordings/startup-session.m4a'],
      );
      expect(jobs, hasLength(1));
      expect(jobs.single['status'], 'pending');
      expect(queueChangeCount, 2);
    },
  );
}

class _StartupRecorder implements RecorderPort {
  @override
  Future<RecordingSessionSnapshot> getState() async {
    return const RecordingSessionSnapshot(
      sessionId: 'startup-session',
      state: 'completed',
      durationMs: 15_808,
      canonicalPath: '/recordings/startup-session.m4a',
      stopReason: 'notification_stop',
    );
  }

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      const <RecordingInputDevice>[];

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) =>
      getState();

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async =>
      const <RecordingRecoveryCandidate>[];

  @override
  Future<void> discardRecovery(String sessionId) => throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> pause() => throw UnimplementedError();

  @override
  Future<RecorderResult> recover(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> resume() => throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) =>
      throw UnimplementedError();

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) =>
      throw UnimplementedError();
}
