import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('v21 upgrade adds desktop capture tables without data loss', () async {
    final root = await Directory.systemTemp.createTemp('schema-v22-capture-');
    final path = '${root.path}/database.db';
    try {
      final v21 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (database, _) async {
            await AppDatabase.createCurrentSchema(database);
            await database.insert('recordings', <String, Object?>{
              'file_path': '/private/existing.wav',
              'duration_ms': 1000,
              'created_at_ms': 1,
            });
          },
        ),
      );
      await v21.execute('DROP TABLE desktop_live_caption_sessions');
      for (final table in <String>[
        'desktop_capture_command_receipts',
        'desktop_capture_events',
        'desktop_capture_chunks',
        'desktop_capture_tracks',
        'desktop_capture_sessions',
      ]) {
        await v21.execute('DROP TABLE $table');
      }
      await v21.execute('PRAGMA user_version = 21');
      await v21.close();

      final owner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
        databaseName: 'database.db',
      );
      final upgraded = await owner.database;
      final tables = (await upgraded.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row['name']).toSet();
      expect(
        tables,
        containsAll(<String>{
          'desktop_capture_sessions',
          'desktop_capture_tracks',
          'desktop_capture_chunks',
          'desktop_capture_events',
          'desktop_capture_command_receipts',
        }),
      );
      expect(
        await upgraded.rawQuery('SELECT COUNT(*) AS count FROM recordings'),
        <Map<String, Object?>>[
          <String, Object?>{'count': 1},
        ],
      );
      expect(await upgraded.rawQuery('PRAGMA foreign_key_check'), isEmpty);
      expect(
        (await upgraded.rawQuery('PRAGMA user_version')).single['user_version'],
        AppDatabase.schemaVersion,
      );
      await upgraded.close();
    } finally {
      await root.delete(recursive: true);
    }
  });
}
