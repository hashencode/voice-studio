import 'package:codex_ui_reproduction/src/codex_app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> pumpDesktop(
    WidgetTester tester, {
    Size size = const Size(1180, 780),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const RepaintBoundary(key: ValueKey('golden-root'), child: CodexApp()),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('light home visual baseline', (tester) async {
    await pumpDesktop(tester);

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_home_light.png'),
    );
  });

  testWidgets('settings visual baseline', (tester) async {
    await pumpDesktop(tester);
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_settings_light.png'),
    );
  });

  testWidgets('dark appearance visual baseline', (tester) async {
    await pumpDesktop(tester);
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('dark-mode-toggle')));
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_settings_dark.png'),
    );
  });

  testWidgets('dark home visual baseline', (tester) async {
    await pumpDesktop(tester);
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('dark-mode-toggle')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('settings-close')));
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_home_dark.png'),
    );
  });

  testWidgets('compact rail visual baseline', (tester) async {
    await pumpDesktop(tester, size: const Size(720, 700));

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_compact_light.png'),
    );
  });

  testWidgets('search overlay visual baseline', (tester) async {
    await pumpDesktop(tester);
    await tester.tap(find.text('Search').first);
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_search_light.png'),
    );
  });

  testWidgets('model menu visual baseline', (tester) async {
    await pumpDesktop(tester);
    await tester.tap(find.text('GPT-5.2-Codex'));
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const ValueKey('golden-root')),
      matchesGoldenFile('goldens/codex_model_menu_light.png'),
    );
  });
}
