import 'dart:io';

import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  sqfliteFfiInit();

  test('v19 upgrade adds independent companion manifests atomically', () async {
    final root = await Directory.systemTemp.createTemp('schema-v20-companion-');
    final path = '${root.path}/database.db';
    try {
      final v19 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (database, _) async {
            await AppDatabase.createCurrentSchema(database);
            await database.insert('recordings', <String, Object?>{
              'file_path': '/private/mobile.wav',
              'display_name': 'Mobile source',
              'group_name': null,
              'deleted_at_ms': null,
              'is_favorite': 0,
              'session_id': null,
              'asset_kind': 'recording',
              'fingerprint_sha256': 'a'.padRight(64, 'a'),
              'source_display_name': 'Mobile source',
              'deletion_state': 'active',
              'active_generation_id': null,
              'duration_ms': 1000,
              'created_at_ms': 1,
            });
            await database.execute('DROP TABLE companion_transfer_chunks');
            await database.execute('DROP TABLE companion_transfers');
            await database.execute('DROP TABLE companion_peers');
          },
        ),
      );
      await v19.execute('PRAGMA user_version = 19');
      await v19.close();

      final appDatabase = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
        databaseName: 'database.db',
      );
      final upgraded = await appDatabase.database;
      expect(
        await upgraded.rawQuery('PRAGMA user_version'),
        <Map<String, Object?>>[
          <String, Object?>{'user_version': AppDatabase.schemaVersion},
        ],
      );
      final names = (await upgraded.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row['name']).toSet();
      expect(
        names,
        containsAll(<String>{
          'companion_peers',
          'companion_transfers',
          'companion_transfer_chunks',
        }),
      );
      expect(
        await upgraded.rawQuery('SELECT COUNT(*) AS count FROM recordings'),
        <Map<String, Object?>>[
          <String, Object?>{'count': 1},
        ],
      );
      await upgraded.close();
    } finally {
      await root.delete(recursive: true);
    }
  });
}
