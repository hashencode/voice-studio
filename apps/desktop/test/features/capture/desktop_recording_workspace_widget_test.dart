import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/captions/live_caption_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';
import 'package:voice2text_desktop/features/capture/desktop_recording_workspace.dart';

import 'capture_widget_test_support.dart';

void main() {
  testWidgets('partial capture and caption degradation stay explicit at 200%', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() {
      tester.binding.setSurfaceSize(null);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
    final controller = FakeCaptureUiController(
      DesktopCaptureViewModel(
        phase: DesktopCapturePhase.recording,
        elapsed: const Duration(minutes: 2, seconds: 3),
        captionEnabled: false,
        captionError: '实时草稿暂不可用；双轨录音继续',
        captionBacklogBytes: 700000,
        draftUtterances: const <LiveCaptionUtterance>[],
        snapshot: const DesktopCaptureSessionSnapshot(
          sessionId: 'session-test-recording',
          state: DesktopCaptureSessionState.partialCapture,
          captureTimelineMs: 123000,
          systemAudioHealthy: true,
          microphoneHealthy: false,
          partialCapture: true,
          finalizedChunkCount: 4,
          eventCount: 1,
        ),
      ),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopRecordingWorkspace(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('02:03'), findsOneWidget);
    expect(find.text('部分轨道仍在录制'), findsOneWidget);
    expect(find.textContaining('另一健康轨会继续录制'), findsOneWidget);
    expect(find.text('已降级'), findsOneWidget);
    expect(find.bySemanticsLabel('实时草稿积压'), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pump();
    expect(controller.pauseCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('stop asks once and invokes shared controller once', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        phase: DesktopCapturePhase.recording,
        snapshot: DesktopCaptureSessionSnapshot(
          sessionId: 'session-test-stop',
          state: DesktopCaptureSessionState.recording,
          captureTimelineMs: 1000,
          systemAudioHealthy: true,
          microphoneHealthy: true,
          partialCapture: false,
          finalizedChunkCount: 0,
          eventCount: 0,
        ),
      ),
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopRecordingWorkspace(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('停止并保存'));
    await tester.pumpAndSettle();
    expect(find.text('停止本次电脑会议？'), findsOneWidget);
    await tester.tap(find.text('停止并保存').last);
    await tester.pumpAndSettle();
    expect(controller.stopCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('microphone-only recording is explicit and not partial', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        phase: DesktopCapturePhase.recording,
        snapshot: DesktopCaptureSessionSnapshot(
          sessionId: 'session-microphone-only',
          state: DesktopCaptureSessionState.recording,
          captureMode: DesktopCaptureMode.microphoneOnly,
          captureTimelineMs: 1000,
          systemAudioHealthy: false,
          microphoneHealthy: true,
          partialCapture: false,
          finalizedChunkCount: 0,
          eventCount: 0,
        ),
      ),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopRecordingWorkspace(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('仅麦克风录音中'), findsOneWidget);
    expect(find.textContaining('仅麦克风兼容模式'), findsOneWidget);
    expect(find.text('未启用'), findsNWidgets(2));
    expect(find.text('部分轨道仍在录制'), findsNothing);
    await tester.tap(find.text('停止并保存'));
    await tester.pumpAndSettle();
    expect(find.textContaining('提交麦克风单轨'), findsOneWidget);
    expect(find.textContaining('提交双轨'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('wake interruption is announced and requires explicit resume', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        phase: DesktopCapturePhase.paused,
        snapshot: DesktopCaptureSessionSnapshot(
          sessionId: 'session-test-wake',
          state: DesktopCaptureSessionState.paused,
          captureTimelineMs: 4000,
          systemAudioHealthy: true,
          microphoneHealthy: true,
          partialCapture: false,
          finalizedChunkCount: 2,
          eventCount: 2,
          interruptionReason: 'system_wake_requires_resume',
        ),
      ),
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopRecordingWorkspace(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Mac 已从睡眠中唤醒；请确认音频设备后点击继续录音。'), findsOneWidget);
    final announcement = tester.getSemantics(
      find.text('Mac 已从睡眠中唤醒；请确认音频设备后点击继续录音。'),
    );
    expect(announcement.label, contains('Mac 已从睡眠中唤醒'));
    expect(
      announcement.getSemanticsData().flagsCollection.isLiveRegion,
      isTrue,
    );
    expect(find.text('继续录音'), findsOneWidget);
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });
}
