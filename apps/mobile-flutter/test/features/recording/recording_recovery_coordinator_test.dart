import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_annotations_repository.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/recording/service/recording_recovery_coordinator.dart';

import 'recording_test_database.dart';

void main() {
  test(
    'refresh mirrors candidates and recover commits one recording',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recorder = _RecoveryRecorder();
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final coordinator = RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      );

      final candidates = await coordinator.refresh();
      expect(candidates, hasLength(1));
      expect(
        (await sessions.findBySessionId('recover-1'))?.state,
        'recoverable',
      );

      final int recordingId = await coordinator.recover('recover-1');
      expect(recordingId, greaterThan(0));
      expect((await sessions.findBySessionId('recover-1'))?.state, 'completed');
      expect(await fixture.database.query('recordings'), hasLength(1));
    },
  );

  test('discard clears the native candidate and marks its mirror', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recorder = _RecoveryRecorder();
    final sessions = RecordingSessionsRepository(database: fixture.appDatabase);
    final coordinator = RecordingRecoveryCoordinator(
      recorder: recorder,
      sessionsRepository: sessions,
    );
    await coordinator.refresh();
    final annotations = RecordingAnnotationsRepository(
      database: fixture.appDatabase,
    );
    await annotations.addMarker(sessionId: 'recover-1', positionMs: 1_000);

    await coordinator.discard('recover-1');

    expect(await recorder.listRecoveries(), isEmpty);
    expect((await sessions.findBySessionId('recover-1'))?.state, 'discarded');
    expect(await annotations.listForSession('recover-1'), isEmpty);
  });
}

class _RecoveryRecorder implements RecorderPort {
  final List<RecordingRecoveryCandidate> _candidates =
      <RecordingRecoveryCandidate>[
        const RecordingRecoveryCandidate(
          sessionId: 'recover-1',
          state: 'recoverable',
          durationMs: 5_000,
          stagingPath: '/private/recover-1.partial',
          canonicalPath: '/private/recover-1.m4a',
          createdAtMs: 100,
          updatedAtMs: 200,
        ),
      ];

  @override
  Future<void> discardRecovery(String sessionId) async {
    _candidates.removeWhere((candidate) => candidate.sessionId == sessionId);
  }

  @override
  Future<RecordingSessionSnapshot> getState() async =>
      RecordingSessionSnapshot.idle();

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      const <RecordingInputDevice>[];

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) =>
      getState();

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async =>
      List<RecordingRecoveryCandidate>.of(_candidates);

  @override
  Future<RecordingSessionSnapshot> pause() => throw UnimplementedError();

  @override
  Future<RecorderResult> recover(String sessionId) async {
    _candidates.removeWhere((candidate) => candidate.sessionId == sessionId);
    return const RecorderResult(
      sessionId: 'recover-1',
      path: '/private/recover-1.m4a',
      durationMs: 5_000,
      stopReason: 'recovered',
    );
  }

  @override
  Future<RecordingSessionSnapshot> resume() => throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) =>
      throw UnimplementedError();

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) =>
      throw UnimplementedError();
}
