import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/app_settings.dart';

class AppSettingsRepository {
  AppSettingsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<AppSettings> load() async {
    final db = await _database.database;
    final rows = await db.query('app_settings', limit: 1);

    if (rows.isEmpty) {
      final defaults = AppSettings.defaults();
      await save(defaults);
      return defaults;
    }

    final row = rows.first;
    return AppSettings(
      modelId: row['model_id'] as String,
      autoTranscribe: (row['auto_transcribe'] as int) == 1,
      isDarkMode: (row['is_dark_mode'] as int? ?? 0) == 1,
    );
  }

  Future<void> save(AppSettings settings) async {
    final db = await _database.database;
    await db.insert('app_settings', {
      'id': 1,
      'model_id': settings.modelId,
      'recording_mode': 'standard',
      'auto_transcribe': settings.autoTranscribe ? 1 : 0,
      'is_dark_mode': settings.isDarkMode ? 1 : 0,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }
}
