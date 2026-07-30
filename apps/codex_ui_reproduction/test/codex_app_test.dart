import 'dart:ui' show PointerDeviceKind;

import 'package:codex_ui_reproduction/src/codex_app.dart';
import 'package:codex_ui_reproduction/src/design/codex_metrics.dart';
import 'package:codex_ui_reproduction/src/design/codex_theme.dart';
import 'package:codex_ui_reproduction/src/icons/codex_icon.dart';
import 'package:codex_ui_reproduction/src/primitives/codex_action.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> pumpApp(
    WidgetTester tester, {
    Size size = const Size(1280, 900),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const CodexApp());
    await tester.pumpAndSettle();
  }

  testWidgets('renders the Codex desktop shell', (tester) async {
    await pumpApp(tester);

    expect(find.text('Codex'), findsOneWidget);
    expect(find.text('What do you want to work on?'), findsOneWidget);
    expect(find.byKey(const ValueKey('composer')), findsOneWidget);

    final sidebar = tester.getSize(find.byKey(const ValueKey('sidebar')));
    expect(sidebar.width, CodexMetrics.sidebarWidth(1280));
  });

  testWidgets('collapses the sidebar', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.byKey(const ValueKey('sidebar-toggle')));
    await tester.pumpAndSettle();

    final sidebar = tester.getSize(find.byKey(const ValueKey('sidebar')));
    expect(sidebar.width, CodexMetrics.railWidth);
    expect(find.text('Recent'), findsNothing);
  });

  testWidgets('uses the Codex tooltip overlay', (tester) async {
    await pumpApp(tester);

    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer();
    await gesture.moveTo(
      tester.getCenter(find.byKey(const ValueKey('sidebar-toggle'))),
    );
    await tester.pump(const Duration(milliseconds: 550));

    expect(find.text('Hide sidebar'), findsOneWidget);

    await gesture.moveTo(const Offset(900, 300));
    await tester.pump();
    expect(find.text('Hide sidebar'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('uses the compact rail in a narrow window', (tester) async {
    await pumpApp(tester, size: const Size(720, 700));

    final sidebar = tester.getSize(find.byKey(const ValueKey('sidebar')));
    expect(sidebar.width, CodexMetrics.railWidth);
    expect(find.byKey(const ValueKey('composer')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('opens search and settings visual states', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.text('Search').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('search-dialog')), findsOneWidget);

    await tester.tapAt(const Offset(1200, 820));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('settings-dialog')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('filters search and supports Command-K and Escape', (
    tester,
  ) async {
    await pumpApp(tester);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('search-dialog')), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('search-field')),
      'responsive',
    );
    await tester.pump();
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('search-dialog')),
        matching: find.text('Create a responsive sidebar'),
      ),
      findsOneWidget,
    );
    expect(find.text('No matching tasks'), findsNothing);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('search-dialog')), findsNothing);
    expect(find.textContaining('renderer width clamp'), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('search-field')),
      'does not exist',
    );
    await tester.pump();
    expect(find.text('No matching tasks'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('search-dialog')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('moves the active search result with arrow keys', (tester) async {
    await pumpApp(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('search-field')));
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    var selectedResult = tester.widget<CodexAction>(
      find.ancestor(
        of: find.descendant(
          of: find.byKey(const ValueKey('search-dialog')),
          matching: find.text('Review the latest implementation'),
        ),
        matching: find.byType(CodexAction),
      ),
    );
    expect(selectedResult.selected, isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('search-dialog')), findsNothing);
    expect(
      find.textContaining('I checked the shell, overlays'),
      findsOneWidget,
    );
  });

  testWidgets('opens source-styled composer menus', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.text('GPT-5.2-Codex'));
    await tester.pumpAndSettle();
    expect(find.text('GPT-5.2-Codex high'), findsOneWidget);
    expect(find.text('GPT-5.1-Codex mini'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    expect(find.text('GPT-5.1-Codex mini'), findsOneWidget);

    await tester.tap(find.text('Local'));
    await tester.pumpAndSettle();
    expect(find.text('Worktree'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Worktree'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('dismisses menus with Escape and restores trigger focus', (
    tester,
  ) async {
    await pumpApp(tester);

    final trigger = find.descendant(
      of: find.byKey(const ValueKey('composer-model-selector')),
      matching: find.byType(CodexAction),
    );
    final action = tester.widget<CodexAction>(trigger);
    action.focusNode!.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('codex-menu-surface')), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('codex-menu-surface')), findsNothing);
    expect(action.focusNode!.hasFocus, isTrue);
    expect(find.text('GPT-5.2-Codex'), findsOneWidget);
  });

  testWidgets('opens a representative task thread', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.text('Rebuild the Codex desktop UI'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('I inspected the packaged renderer'),
      findsOneWidget,
    );
    expect(find.text('Verify light and dark states'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('keeps the selected recent task consistent', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.text('Review the latest implementation'));
    await tester.pumpAndSettle();

    expect(find.text('Review the latest implementation'), findsNWidgets(2));
    expect(
      find.textContaining('I checked the shell, overlays'),
      findsOneWidget,
    );
    final selectedRows = [
      for (var index = 0; index < 5; index++)
        tester
            .widget<CodexAction>(
              find.descendant(
                of: find.byKey(ValueKey('task-row-$index')),
                matching: find.byType(CodexAction),
              ),
            )
            .selected,
    ];
    expect(selectedRows, [false, true, false, false, false]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('exposes local composer states and submission', (tester) async {
    await pumpApp(tester);

    await tester.tap(find.byKey(const ValueKey('composer-context')));
    await tester.pumpAndSettle();
    expect(find.text('Add files'), findsOneWidget);
    await tester.tap(find.text('Add files'));
    await tester.pumpAndSettle();
    expect(find.text('Files attached'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('composer-voice')));
    await tester.pump();
    final voiceAction = tester.widget<CodexAction>(
      find.descendant(
        of: find.byKey(const ValueKey('composer-voice')),
        matching: find.byType(CodexAction),
      ),
    );
    expect(voiceAction.selected, isTrue);
    await tester.enterText(
      find.byKey(const ValueKey('composer-input')),
      'Inspect this local preview',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pumpAndSettle();
    expect(find.text('Inspect this local preview'), findsOneWidget);
    final submittedVoiceAction = tester.widget<CodexAction>(
      find.descendant(
        of: find.byKey(const ValueKey('composer-voice')),
        matching: find.byType(CodexAction),
      ),
    );
    expect(submittedVoiceAction.selected, isFalse);
    final sendAction = tester.widget<CodexAction>(
      find.byKey(const ValueKey('composer-send')),
    );
    expect(sendAction.onPressed, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('appends follow-up prompts in an existing task', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('Rebuild the Codex desktop UI'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('composer-input')),
      'Tighten the menu spacing',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pumpAndSettle();

    expect(
      find.text('Tighten the menu spacing', skipOffstage: false),
      findsOneWidget,
    );
    expect(
      find.byKey(
        const ValueKey('task-follow-up-response'),
        skipOffstage: false,
      ),
      findsOneWidget,
    );
  });

  testWidgets('retains workspace and settings selector choices', (
    tester,
  ) async {
    await pumpApp(tester);

    await tester.tap(find.byKey(const ValueKey('composer-workspace-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open folder...'));
    await tester.pumpAndSettle();
    expect(find.text('Open folder...'), findsOneWidget);

    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('settings-select-Default workspace')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose folder...'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('settings-select-Interface density')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Compact'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('General'));
    await tester.pumpAndSettle();

    expect(find.text('Choose folder...'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('settings-select-Default workspace')),
    );
    await tester.pumpAndSettle();
    final selectedSetting = find.ancestor(
      of: find.descendant(
        of: find.byKey(const ValueKey('codex-menu-surface')),
        matching: find.text('Choose folder...'),
      ),
      matching: find.byType(CodexAction),
    );
    expect(tester.widget<CodexAction>(selectedSetting).selected, isTrue);
    expect(
      find.descendant(of: selectedSetting, matching: find.byType(CodexIcon)),
      findsNWidgets(2),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    expect(find.text('Compact'), findsOneWidget);
  });

  testWidgets('switches the complete shell to dark theme', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('dark-mode-toggle')));
    await tester.pumpAndSettle();

    expect(
      Theme.of(tester.element(find.byType(Scaffold))).brightness,
      Brightness.dark,
    );
    final barrier = tester.widget<ColoredBox>(
      find.byKey(const ValueKey('codex-dialog-barrier')),
    );
    expect(barrier.color, CodexThemeData.dark.scrim);

    await tester.tap(find.byKey(const ValueKey('dark-mode-toggle')));
    await tester.pumpAndSettle();
    expect(
      Theme.of(tester.element(find.byType(Scaffold))).brightness,
      Brightness.light,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('opens the nested feature dialog', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('Settings').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('About'));
    await tester.pumpAndSettle();
    await tester.tap(find.text("What's new"));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('feature-dialog')), findsOneWidget);
    expect(find.text('Schedule recurring work'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
