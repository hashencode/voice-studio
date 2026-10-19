import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/widgets/recording_recovery_panel.dart';

const _candidates = <RecordingRecoveryCandidate>[
  RecordingRecoveryCandidate(
    sessionId: 'first',
    state: 'recoverable',
    durationMs: 5000,
  ),
  RecordingRecoveryCandidate(
    sessionId: 'second',
    state: 'invalid',
    durationMs: 10000,
  ),
];

void main() {
  testWidgets('canceling deletion keeps the candidate without discarding', (
    tester,
  ) async {
    final discarded = <String>[];
    await _pumpPanel(
      tester,
      onDiscard: (id) async {
        discarded.add(id);
        return true;
      },
    );
    await tester.tap(find.text('删除').first);
    await tester.pumpAndSettle();
    expect(discarded, isEmpty);
    expect(find.text('删除后无法恢复这段录音。'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(discarded, isEmpty);
    expect(find.text('未完成录音 · 00:05'), findsOneWidget);
  });

  testWidgets(
    'confirmed deletion affects only its target and failed deletion remains retryable',
    (tester) async {
      final discarded = <String>[];
      var succeeds = false;
      var resolved = 0;
      await _pumpPanel(
        tester,
        onDiscard: (id) async {
          discarded.add(id);
          return succeeds;
        },
        onAllResolved: () => resolved++,
      );
      await _confirmDelete(tester, 1);
      expect(discarded, <String>['second']);
      expect(find.text('未完成录音 · 00:10'), findsOneWidget);
      expect(resolved, 0);
      succeeds = true;
      await _confirmDelete(tester, 1);
      expect(discarded, <String>['second', 'second']);
      expect(find.text('未完成录音 · 00:10'), findsNothing);
      expect(find.text('未完成录音 · 00:05'), findsOneWidget);
      expect(resolved, 0);
      await tester.tap(find.text('恢复'));
      await tester.pumpAndSettle();
      expect(resolved, 1);
      expect(find.text('没有待处理录音'), findsOneWidget);
    },
  );
}

Future<void> _pumpPanel(
  WidgetTester tester, {
  required Future<bool> Function(String) onDiscard,
  VoidCallback? onAllResolved,
}) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: RecordingRecoveryPanel(
        candidates: _candidates,
        onRecover: (_) async => true,
        onDiscard: onDiscard,
        onAllResolved: onAllResolved ?? () {},
      ),
    ),
  ),
);

Future<void> _confirmDelete(WidgetTester tester, int index) async {
  await tester.tap(find.text('删除').at(index));
  await tester.pumpAndSettle();
  await tester.tap(
    find.descendant(of: find.byType(GooDialog), matching: find.text('删除')),
  );
  await tester.pumpAndSettle();
}
