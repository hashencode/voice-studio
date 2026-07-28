import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('v22 upgrade adds live-caption authority state', () async {
    final root = await Directory.systemTemp.createTemp('schema-v23-caption-');
    final path = '${root.path}/database.db';
    try {
      final v22 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (database, _) async {
            await AppDatabase.createCurrentSchema(database);
            await database.execute('DROP TABLE desktop_live_caption_sessions');
            await database.insert('recordings', <String, Object?>{
              'file_path': '/private/existing.wav',
              'duration_ms': 1000,
              'created_at_ms': 1,
            });
          },
        ),
      );
      await v22.execute('PRAGMA user_version = 22');
      await v22.close();

      final owner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
        databaseName: 'database.db',
      );
      final upgraded = await owner.database;
      final tables = (await upgraded.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row['name']).toSet();
      expect(tables, contains('desktop_live_caption_sessions'));
      final generationColumns = (await upgraded.rawQuery(
        'PRAGMA table_info(transcript_generations)',
      )).map((row) => row['name']).toSet();
      expect(
        generationColumns,
        containsAll(<String>{
          'generation_kind',
          'supersedes_generation_id',
          'reconciliation_state',
        }),
      );
      final segmentColumns = (await upgraded.rawQuery(
        'PRAGMA table_info(transcript_segments)',
      )).map((row) => row['name']).toSet();
      expect(
        segmentColumns,
        containsAll(<String>{
          'language',
          'model_sha256',
          'caption_session_id',
          'worker_offset_bytes',
        }),
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
