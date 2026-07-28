import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_controller.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_preflight_page.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';
import 'package:voice2text_desktop/features/capture/desktop_recording_workspace.dart';

import '../test_support/fake_capture_service.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'preflight, menu pause/resume and confirmed stop share one controller',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final service = FakeCaptureService();
      final formal = FakeFormalTranscription();
      final controller = DesktopCaptureController(
        captureService: service,
        formalTranscription: formal,
      );
      addTearDown(() async {
        controller.dispose();
        await service.dispose();
      });
      await controller.initialize();
      await controller.preflight();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AnimatedBuilder(
              animation: controller,
              builder: (_, _) {
                final model = controller.value;
                return switch (model.phase) {
                  DesktopCapturePhase.checking ||
                  DesktopCapturePhase.ready => DesktopCapturePreflightPage(
                    controller: controller,
                    model: model,
                  ),
                  _ => DesktopRecordingWorkspace(
                    controller: controller,
                    model: model,
                  ),
                };
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('开始录音'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('电脑会议录音中'), findsOneWidget);
      expect(find.bySemanticsLabel('系统音频轨 电平 60%'), findsOneWidget);
      expect(find.bySemanticsLabel('麦克风轨 电平 40%'), findsOneWidget);

      service.menuController.add(DesktopCaptureMenuAction.pause);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('电脑会议已暂停'), findsOneWidget);
      service.menuController.add(DesktopCaptureMenuAction.resume);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('电脑会议录音中'), findsOneWidget);

      await tester.tap(find.text('停止并保存'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('停止并保存').last);
      await tester.pumpAndSettle();
      expect(find.text('录音已安全保存'), findsOneWidget);
      expect(service.stopCalls, 1);
      expect(formal.enqueueCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );
}
