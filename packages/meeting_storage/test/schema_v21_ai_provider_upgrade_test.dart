import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('v20 upgrade adds only non-secret provider endpoint settings', () async {
    final root = await Directory.systemTemp.createTemp('schema-v21-ai-');
    final path = '${root.path}/database.db';
    try {
      final v20 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (database, _) => AppDatabase.createCurrentSchema(database),
        ),
      );
      await v20.execute(
        'ALTER TABLE app_settings DROP COLUMN meeting_ai_endpoint',
      );
      await v20.execute('PRAGMA user_version = 20');
      await v20.close();

      final owner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
        databaseName: 'database.db',
      );
      final upgraded = await owner.database;
      final columns = await upgraded.rawQuery(
        'PRAGMA table_info(app_settings)',
      );
      expect(
        columns.map((row) => row['name']),
        contains('meeting_ai_endpoint'),
      );
      expect(
        columns.map((row) => row['name']),
        isNot(contains('meeting_ai_api_key')),
      );
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
