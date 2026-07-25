import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/app/theme/theme_mode_controller.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';
import 'package:voice2text_flutter/features/settings/settings_page.dart';

void main() {
  testWidgets('settings uses Goo loading and remains usable at 200% text', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = _MemorySettingsRepository();
    final themeController = AppThemeModeController(repository: repository);
    addTearDown(themeController.dispose);

    await tester.pumpWidget(
      AppThemeModeScope(
        notifier: themeController,
        child: MaterialApp(
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: ThemeMode.dark,
          builder: (BuildContext context, Widget? child) {
            final mediaQuery = MediaQuery.of(context);
            return MediaQuery(
              data: mediaQuery.copyWith(textScaler: const TextScaler.linear(2)),
              child: GooToastScope(
                child: GooSnackbarScope(
                  child: child ?? const SizedBox.shrink(),
                ),
              ),
            );
          },
          home: SettingsPage(repository: repository),
        ),
      ),
    );
    await tester.pump();

    expect(
      find.byWidgetPredicate(
        (Widget widget) =>
            widget is GooSpinner &&
            widget.semanticLabel == '正在加载设置' &&
            widget.liveRegion,
      ),
      findsOneWidget,
    );

    repository.completeLoad();
    await tester.pumpAndSettle();
    expect(find.text('识别模型'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.scrollUntilVisible(
      find.text('保存设置'),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('保存设置'));
    await tester.pumpAndSettle();

    expect(repository.savedSettings, hasLength(1));
    expect(find.text('设置已保存'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class _MemorySettingsRepository extends AppSettingsRepository {
  final Completer<AppSettings> _initialLoad = Completer<AppSettings>();
  final List<AppSettings> savedSettings = <AppSettings>[];

  void completeLoad() {
    if (!_initialLoad.isCompleted) {
      _initialLoad.complete(AppSettings.defaults());
    }
  }

  @override
  Future<AppSettings> load() => _initialLoad.future;

  @override
  Future<void> save(AppSettings settings) async {
    savedSettings.add(settings);
  }
}
