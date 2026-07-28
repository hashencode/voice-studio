import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_controller.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';

import '../../../test_support/fake_capture_service.dart';

void main() {
  test('menu bar and window share pause/resume/stop idempotency', () async {
    final stopGate = Completer<void>();
    final service = FakeCaptureService(stopGate: stopGate);
    final formal = FakeFormalTranscription();
    final controller = DesktopCaptureController(
      captureService: service,
      formalTranscription: formal,
      clock: () => DateTime.fromMillisecondsSinceEpoch(1000),
    );
    addTearDown(() async {
      controller.dispose();
      await service.dispose();
    });

    await controller.initialize();
    await controller.preflight();
    expect(controller.value.phase, DesktopCapturePhase.ready);
    await controller.start();
    expect(service.startCalls, 1);
    expect(service.selectedMicrophoneDeviceId, 'microphone-default');

    service.menuController.add(DesktopCaptureMenuAction.pause);
    await Future<void>.delayed(Duration.zero);
    expect(service.pauseCalls, 1);
    expect(controller.value.phase, DesktopCapturePhase.paused);
    service.menuController.add(DesktopCaptureMenuAction.resume);
    await Future<void>.delayed(Duration.zero);
    expect(service.resumeCalls, 1);
    expect(controller.value.phase, DesktopCapturePhase.recording);

    final windowStop = controller.stop();
    service.menuController.add(DesktopCaptureMenuAction.stop);
    final duplicateStop = controller.stop();
    await Future<void>.delayed(Duration.zero);
    expect(service.stopCalls, 1);
    stopGate.complete();
    final outcomes = await Future.wait([windowStop, duplicateStop]);
    expect(outcomes.first?.formalJob.jobId, 91);
    expect(outcomes.last?.formalJob.jobId, 91);
    expect(service.stopCalls, 1);
    expect(formal.enqueueCalls, 1);
    expect(controller.value.phase, DesktopCapturePhase.completed);
  });

  test('native sleep pauses UI time until explicit wake resume', () async {
    final service = FakeCaptureService();
    final controller = DesktopCaptureController(
      captureService: service,
      formalTranscription: FakeFormalTranscription(),
    );
    addTearDown(() async {
      controller.dispose();
      await service.dispose();
    });

    await controller.initialize();
    await controller.preflight();
    await controller.start();
    await Future<void>.delayed(const Duration(milliseconds: 300));

    service.snapshotController.add(
      DesktopCaptureSessionSnapshot(
        sessionId: service.sessionId!,
        state: DesktopCaptureSessionState.paused,
        captureTimelineMs: 300,
        systemAudioHealthy: true,
        microphoneHealthy: true,
        partialCapture: false,
        finalizedChunkCount: 1,
        eventCount: 1,
        interruptionReason: 'system_sleep',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(controller.value.phase, DesktopCapturePhase.paused);
    final pausedElapsed = controller.value.elapsed;

    await Future<void>.delayed(const Duration(milliseconds: 350));
    expect(controller.value.elapsed, pausedElapsed);

    service.snapshotController.add(
      DesktopCaptureSessionSnapshot(
        sessionId: service.sessionId!,
        state: DesktopCaptureSessionState.paused,
        captureTimelineMs: 300,
        systemAudioHealthy: true,
        microphoneHealthy: true,
        partialCapture: false,
        finalizedChunkCount: 1,
        eventCount: 2,
        interruptionReason: 'system_wake_requires_resume',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(controller.value.phase, DesktopCapturePhase.paused);

    await controller.resume();
    expect(service.resumeCalls, 1);
    expect(controller.value.phase, DesktopCapturePhase.recording);
  });

  test(
    'microphone-only mode starts as an intentional complete track set',
    () async {
      final service = FakeCaptureService(
        preflight: const DesktopCapturePreflight(
          minimumMacosVersion: '13.0',
          systemAudioMinimumMacosVersion: '14.2',
          captureMode: DesktopCaptureMode.microphoneOnly,
          systemAudioPermission: DesktopCapturePermissionState.unavailable,
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
        ),
      );
      final controller = DesktopCaptureController(
        captureService: service,
        formalTranscription: FakeFormalTranscription(),
      );
      addTearDown(() async {
        controller.dispose();
        await service.dispose();
      });

      await controller.initialize();
      await controller.preflight();
      await controller.start();

      expect(controller.value.microphoneOnly, isTrue);
      expect(controller.value.partialCapture, isFalse);
      expect(controller.value.systemAudioHealthy, isFalse);
      expect(controller.value.microphoneHealthy, isTrue);
    },
  );
}
