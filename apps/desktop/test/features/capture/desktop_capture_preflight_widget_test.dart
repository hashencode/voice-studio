import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_preflight_page.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';

import 'capture_widget_test_support.dart';

void main() {
  testWidgets(
    'preflight explains denied permission, missing device and low disk at 200%',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(() {
        tester.binding.setSurfaceSize(null);
        tester.platformDispatcher.clearTextScaleFactorTestValue();
      });
      final controller = FakeCaptureUiController(
        const DesktopCaptureViewModel(
          phase: DesktopCapturePhase.ready,
          preflight: DesktopCapturePreflight(
            minimumMacosVersion: '14.2',
            systemAudioPermission: DesktopCapturePermissionState.unavailable,
            microphonePermission: DesktopCapturePermissionState.denied,
            microphones: <DesktopCaptureDevice>[],
            availableBytes: 256 * 1024 * 1024,
            requiredBytes: 1024 * 1024 * 1024,
            captionModelAvailable: false,
            canStart: false,
            blockingReasons: <String>[
              'microphone_permission_denied',
              'microphone_device_missing',
              'disk_space_low',
            ],
          ),
        ),
      );
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        captureTestApp(
          controller: controller,
          builder: (model) =>
              DesktopCapturePreflightPage(controller: controller, model: model),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('已拒绝'), findsOneWidget);
      expect(find.textContaining('模型未安装'), findsOneWidget);
      expect(find.text('开始录音'), findsOneWidget);
      expect(
        tester.widget<Semantics>(
          find
              .ancestor(of: find.text('开始录音'), matching: find.byType(Semantics))
              .first,
        ),
        isNotNull,
      );
      await tester.scrollUntilVisible(
        find.text('检查并请求权限'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.text('检查并请求权限'));
      await tester.pump();
      expect(controller.permissionPreflightCalls, 1);
      expect(controller.startCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('ready preflight selects a real device and starts', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        phase: DesktopCapturePhase.ready,
        selectedMicrophoneId: 'built-in',
        captionAvailable: true,
        captionEnabled: true,
        preflight: DesktopCapturePreflight(
          minimumMacosVersion: '14.2',
          systemAudioPermission: DesktopCapturePermissionState.notDetermined,
          microphonePermission: DesktopCapturePermissionState.granted,
          microphones: <DesktopCaptureDevice>[
            DesktopCaptureDevice(
              id: 'built-in',
              name: 'Mac mini 麦克风',
              isDefault: true,
            ),
            DesktopCaptureDevice(
              id: 'headset',
              name: '外置耳机麦克风',
              isDefault: false,
            ),
          ],
          availableBytes: 20 * 1024 * 1024 * 1024,
          requiredBytes: 1024 * 1024 * 1024,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: <String>[],
        ),
      ),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopCapturePreflightPage(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('外置耳机麦克风'));
    await tester.pump();
    expect(controller.value.selectedMicrophoneId, 'headset');
    await tester.tap(find.text('开始录音'));
    await tester.pump();
    expect(controller.startCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('macOS 13 microphone-only mode warns and remains startable', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        phase: DesktopCapturePhase.ready,
        selectedMicrophoneId: 'headset',
        preflight: DesktopCapturePreflight(
          minimumMacosVersion: '13.0',
          systemAudioMinimumMacosVersion: '14.2',
          captureMode: DesktopCaptureMode.microphoneOnly,
          systemAudioPermission: DesktopCapturePermissionState.unavailable,
          microphonePermission: DesktopCapturePermissionState.granted,
          microphones: <DesktopCaptureDevice>[
            DesktopCaptureDevice(
              id: 'headset',
              name: '外置耳机麦克风',
              isDefault: true,
            ),
          ],
          availableBytes: 20 * 1024 * 1024 * 1024,
          requiredBytes: 1024 * 1024 * 1024,
          captionModelAvailable: false,
          canStart: true,
          blockingReasons: <String>[],
        ),
      ),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopCapturePreflightPage(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('兼容模式：当前 macOS'), findsOneWidget);
    expect(find.textContaining('不会录到电脑播放的声音'), findsOneWidget);
    expect(find.text('未启用'), findsOneWidget);
    expect(find.text('开始仅麦克风录音'), findsOneWidget);
    await tester.tap(find.text('开始仅麦克风录音'));
    await tester.pump();
    expect(controller.startCalls, 1);
    expect(tester.takeException(), isNull);
  });
}
