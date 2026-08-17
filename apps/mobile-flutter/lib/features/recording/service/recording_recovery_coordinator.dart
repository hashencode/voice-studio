import '../engine/recorder_port.dart';
import '../repository/recording_sessions_repository.dart';

class RecordingRecoveryCoordinator {
  RecordingRecoveryCoordinator({
    required RecorderPort recorder,
    required RecordingSessionsRepository sessionsRepository,
  }) : _recorder = recorder,
       _sessionsRepository = sessionsRepository;

  final RecorderPort _recorder;
  final RecordingSessionsRepository _sessionsRepository;

  Future<List<RecordingRecoveryCandidate>> refresh() async {
    final candidates = await _recorder.listRecoveries();
    for (final candidate in candidates) {
      await _sessionsRepository.upsertSnapshot(candidate);
    }
    return candidates;
  }

  Future<int> recover(
    String sessionId, {
    bool enqueueTranscription = false,
  }) async {
    final result = await _recorder.recover(sessionId);
    return _sessionsRepository.commitCompleted(
      result,
      enqueueTranscription: enqueueTranscription,
    );
  }

  Future<void> discard(String sessionId) async {
    await _recorder.discardRecovery(sessionId);
    await _sessionsRepository.markDiscarded(sessionId);
  }

  Future<RecordingSessionSnapshot> reattach({
    bool enqueueTranscription = false,
  }) async {
    final snapshot = await _recorder.getState();
    await _sessionsRepository.upsertSnapshot(snapshot);
    if (snapshot.isCompleted &&
        snapshot.sessionId.isNotEmpty &&
        (snapshot.canonicalPath?.isNotEmpty ?? false)) {
      await _sessionsRepository.commitCompleted(
        RecorderResult(
          sessionId: snapshot.sessionId,
          path: snapshot.canonicalPath!,
          durationMs: snapshot.durationMs,
          stopReason: snapshot.stopReason,
        ),
        enqueueTranscription: enqueueTranscription,
      );
    }
    return snapshot;
  }
}
