import 'dart:async';

import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_service.dart';

class FakeCaptureService implements DesktopCaptureService {
  FakeCaptureService({DesktopCapturePreflight? preflight, this.stopGate})
    : preflightResult =
          preflight ??
          const DesktopCapturePreflight(
            minimumMacosVersion: '14.2',
            systemAudioPermission: DesktopCapturePermissionState.notDetermined,
            microphonePermission: DesktopCapturePermissionState.granted,
            microphones: <DesktopCaptureDevice>[
              DesktopCaptureDevice(
                id: 'microphone-default',
                name: '测试麦克风',
                isDefault: true,
              ),
            ],
            availableBytes: 20 * 1024 * 1024 * 1024,
            requiredBytes: 1024 * 1024 * 1024,
            captionModelAvailable: false,
            canStart: true,
            blockingReasons: <String>[],
          );

  final DesktopCapturePreflight preflightResult;
  final Completer<void>? stopGate;
  final StreamController<DesktopCaptureSessionSnapshot> snapshotController =
      StreamController<DesktopCaptureSessionSnapshot>.broadcast();
  final StreamController<DesktopCaptureMenuAction> menuController =
      StreamController<DesktopCaptureMenuAction>.broadcast();

  int startCalls = 0;
  int pauseCalls = 0;
  int resumeCalls = 0;
  int stopCalls = 0;
  String? sessionId;
  String? selectedMicrophoneDeviceId;

  @override
  Stream<DesktopCaptureMenuAction> get menuActions => menuController.stream;

  @override
  Stream<DesktopCaptureSessionSnapshot> get snapshots =>
      snapshotController.stream;

  @override
  Future<DesktopCapturePreflight> preflight({
    required int minimumFreeBytes,
    required bool captionModelAvailable,
    bool requestPermissions = false,
  }) async => preflightResult;

  @override
  Future<DesktopCaptureSessionSnapshot> start({
    required String sessionId,
    required String idempotencyKey,
    required int minimumFreeBytes,
    String? microphoneDeviceId,
    bool captionEnabled = false,
  }) async {
    startCalls += 1;
    this.sessionId = sessionId;
    selectedMicrophoneDeviceId = microphoneDeviceId;
    return _snapshot(DesktopCaptureSessionState.recording, 0);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> pause({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    pauseCalls += 1;
    return _snapshot(DesktopCaptureSessionState.paused, 1000);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> resume({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    resumeCalls += 1;
    return _snapshot(DesktopCaptureSessionState.recording, 1000);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> stop({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    stopCalls += 1;
    await stopGate?.future;
    return _snapshot(DesktopCaptureSessionState.completed, 5000);
  }

  @override
  Future<CommittedMeetingCapture> stopAndCommit({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    await stop(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      displayName: displayName,
    );
    return CommittedMeetingCapture(
      sessionId: sessionId,
      recordingId: 41,
      recordingPath: '/private/capture/journal.json',
      processingPath: '/private/capture/processing/qwen3-post-meeting.wav',
      recordingSha256: 'a' * 64,
      durationMs: 5000,
      partialCapture: false,
    );
  }

  @override
  Future<DesktopCaptureSessionRecord?> sessionRecord(String sessionId) async {
    return DesktopCaptureSessionRecord(
      sessionId: sessionId,
      state: 'recording',
      workspacePath: '/private/capture/$sessionId',
      captureTimelineMs: 0,
      partialCapture: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    );
  }

  @override
  Future<CommittedMeetingCapture> keepRecovered({
    required String sessionId,
    required String displayName,
  }) async => CommittedMeetingCapture(
    sessionId: sessionId,
    recordingId: 42,
    recordingPath: '/private/capture/recovered/journal.json',
    processingPath:
        '/private/capture/recovered/processing/qwen3-post-meeting.wav',
    recordingSha256: 'b' * 64,
    durationMs: 3000,
    partialCapture: true,
  );

  @override
  Future<void> discardRecovered(String sessionId) async {}

  @override
  Future<List<DesktopCaptureRecoveryResult>> recoverInterrupted() async =>
      const <DesktopCaptureRecoveryResult>[];

  DesktopCaptureSessionSnapshot _snapshot(
    DesktopCaptureSessionState state,
    int timelineMs,
  ) {
    return DesktopCaptureSessionSnapshot(
      sessionId: sessionId!,
      state: state,
      captureMode: preflightResult.captureMode,
      captureTimelineMs: timelineMs,
      systemAudioHealthy:
          state == DesktopCaptureSessionState.recording &&
          preflightResult.captureMode == DesktopCaptureMode.dualTrack,
      microphoneHealthy: state == DesktopCaptureSessionState.recording,
      systemAudioLevel: 0.6,
      microphoneLevel: 0.4,
      partialCapture: false,
      finalizedChunkCount: state == DesktopCaptureSessionState.completed
          ? 2
          : 0,
      eventCount: 0,
    );
  }

  Future<void> dispose() async {
    await snapshotController.close();
    await menuController.close();
  }
}

class FakeFormalTranscription implements MeetingFormalTranscriptionPort {
  int enqueueCalls = 0;

  @override
  Future<FormalTranscriptionJobReference> enqueuePostMeeting(
    CommittedMeetingCapture capture,
  ) async {
    enqueueCalls += 1;
    return const FormalTranscriptionJobReference(jobId: 91, inserted: true);
  }
}
