import 'dart:ui' show PointerDeviceKind;

import 'package:codex_ui_reproduction/src/design/codex_theme.dart';
import 'package:codex_ui_reproduction/src/primitives/codex_action.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'shared actions expose pointer, pressed, focus, and disabled states',
    (tester) async {
      final focusNode = FocusNode();
      addTearDown(focusNode.dispose);
      final previousHighlightStrategy = FocusManager.instance.highlightStrategy;
      FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.alwaysTraditional;
      addTearDown(() {
        FocusManager.instance.highlightStrategy = previousHighlightStrategy;
      });
      var activations = 0;

      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(extensions: const [CodexThemeData.light]),
          home: Center(
            child: CodexAction(
              key: const ValueKey('action'),
              focusNode: focusNode,
              onPressed: () => activations++,
              child: const SizedBox(width: 80, height: 30),
            ),
          ),
        ),
      );

      Finder surface() => find.descendant(
        of: find.byKey(const ValueKey('action')),
        matching: find.byType(AnimatedContainer),
      );
      BoxDecoration decoration() =>
          tester.widget<AnimatedContainer>(surface()).decoration!
              as BoxDecoration;

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: const Offset(1, 1));
      await mouse.moveTo(
        tester.getCenter(find.byKey(const ValueKey('action'))),
      );
      await tester.pumpAndSettle();
      expect(decoration().color, CodexThemeData.light.hover);

      await mouse.down(tester.getCenter(find.byKey(const ValueKey('action'))));
      await tester.pumpAndSettle();
      expect(decoration().color, CodexThemeData.light.active);
      await mouse.up();

      focusNode.requestFocus();
      await tester.pumpAndSettle();
      expect(decoration().border, isNotNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(activations, 2);

      final detector = tester.widget<FocusableActionDetector>(
        find.descendant(
          of: find.byKey(const ValueKey('action')),
          matching: find.byType(FocusableActionDetector),
        ),
      );
      expect(detector.mouseCursor, SystemMouseCursors.click);
    },
  );

  testWidgets('disabled shared actions remain inactive', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(extensions: const [CodexThemeData.light]),
        home: const Center(
          child: CodexAction(
            key: ValueKey('disabled-action'),
            onPressed: null,
            child: SizedBox(width: 80, height: 30),
          ),
        ),
      ),
    );

    final detector = tester.widget<FocusableActionDetector>(
      find.descendant(
        of: find.byKey(const ValueKey('disabled-action')),
        matching: find.byType(FocusableActionDetector),
      ),
    );
    expect(detector.enabled, isFalse);
    expect(detector.mouseCursor, SystemMouseCursors.basic);
  });
}
