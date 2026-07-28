import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery_page.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';

import 'capture_widget_test_support.dart';

void main() {
  testWidgets('recovery keeps or deletes only the selected session', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FakeCaptureUiController(
      const DesktopCaptureViewModel(
        recoveries: <DesktopCaptureRecoveryResult>[
          DesktopCaptureRecoveryResult(
            sessionId: 'session-recover-aaaaaaaa',
            state: 'recoverable',
            validatedChunkCount: 8,
            error: null,
          ),
          DesktopCaptureRecoveryResult(
            sessionId: 'session-recover-bbbbbbbb',
            state: 'partial_capture',
            validatedChunkCount: 3,
            error: null,
          ),
        ],
      ),
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      captureTestApp(
        controller: controller,
        builder: (model) =>
            DesktopCaptureRecoveryPage(controller: controller, model: model),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('aaaaaaaa'), findsOneWidget);
    expect(find.textContaining('bbbbbbbb'), findsOneWidget);
    expect(find.textContaining('部分轨道'), findsOneWidget);
    await tester.tap(find.text('保留并处理').first);
    await tester.pump();
    expect(controller.keptSessions, <String>['session-recover-aaaaaaaa']);

    await tester.tap(find.text('删除').last);
    await tester.pumpAndSettle();
    expect(find.text('删除这一个恢复会话？'), findsOneWidget);
    await tester.tap(find.text('删除会话'));
    await tester.pumpAndSettle();
    expect(controller.discardedSessions, <String>['session-recover-bbbbbbbb']);
    expect(tester.takeException(), isNull);
  });
}
