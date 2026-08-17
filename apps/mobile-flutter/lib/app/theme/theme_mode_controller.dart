import 'package:flutter/material.dart';

import '../../features/settings/repository/app_settings_repository.dart';

class AppThemeModeController extends ChangeNotifier {
  AppThemeModeController({AppSettingsRepository? repository})
    : _repository = repository ?? AppSettingsRepository();

  final AppSettingsRepository _repository;
  ThemeMode _themeMode = ThemeMode.light;
  bool _loaded = false;

  ThemeMode get themeMode => _themeMode;
  bool get isDarkMode => _themeMode == ThemeMode.dark;
  bool get isLoaded => _loaded;

  Future<void> load() async {
    try {
      final settings = await _repository.load();
      _themeMode = settings.isDarkMode ? ThemeMode.dark : ThemeMode.light;
    } catch (_) {
      _themeMode = ThemeMode.light;
    }
    _loaded = true;
    notifyListeners();
  }

  Future<void> setDarkMode(bool isDarkMode) async {
    if (_themeMode == (isDarkMode ? ThemeMode.dark : ThemeMode.light)) {
      return;
    }
    try {
      final settings = await _repository.load();
      await _repository.save(settings.copyWith(isDarkMode: isDarkMode));
    } catch (_) {
      // Fall back to in-memory theme changes when persistence is unavailable.
    }
    _themeMode = isDarkMode ? ThemeMode.dark : ThemeMode.light;
    notifyListeners();
  }

  Future<void> toggle() async {
    await setDarkMode(!isDarkMode);
  }
}

class AppThemeModeScope extends InheritedNotifier<AppThemeModeController> {
  const AppThemeModeScope({
    required super.notifier,
    required super.child,
    super.key,
  });

  static AppThemeModeController? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<AppThemeModeScope>()
        ?.notifier;
  }

  static AppThemeModeController of(BuildContext context) {
    final AppThemeModeController? controller = maybeOf(context);
    assert(controller != null, 'AppThemeModeScope not found in context');
    return controller!;
  }
}
