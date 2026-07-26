import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test('fresh-create and v20 reopen use the same FFI schema', () async {
    final root = await Directory.systemTemp.createTemp('meeting-storage-');
    addTearDown(() => root.delete(recursive: true));

    final freshOwner = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'fresh.db',
    );
    final fresh = await freshOwner.database;
    addTearDown(fresh.close);

    final upgradePath = '${root.path}/upgrade.db';
    var upgrade = await databaseFactoryFfi.openDatabase(
      upgradePath,
      options: OpenDatabaseOptions(
        version: 18,
        onConfigure: (database) => database.execute('PRAGMA foreign_keys = ON'),
        onCreate: (database, _) => AppDatabase.createCurrentSchema(database),
      ),
    );
    await upgrade.close();
    final upgradeOwner = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'upgrade.db',
    );
    upgrade = await upgradeOwner.database;
    addTearDown(upgrade.close);

    expect(await _schemaObjects(upgrade), await _schemaObjects(fresh));
    expect(await fresh.rawQuery('PRAGMA foreign_key_check'), isEmpty);
    expect(await upgrade.rawQuery('PRAGMA foreign_key_check'), isEmpty);
    expect(
      (await upgrade.rawQuery('PRAGMA user_version')).single['user_version'],
      AppDatabase.schemaVersion,
    );
  });

  test(
    'desktop factory owns a database below its app support directory',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'meeting-storage-support-',
      );
      addTearDown(() => root.delete(recursive: true));
      final owner = await DesktopDatabaseFactory(
        supportDirectoryProvider: () async => root,
        databaseName: 'desktop.db',
      ).create();
      final database = await owner.database;
      addTearDown(database.close);

      expect(
        await database.rawQuery('PRAGMA user_version'),
        <Map<String, Object?>>[
          <String, Object?>{'user_version': AppDatabase.schemaVersion},
        ],
      );
      expect(File('${root.path}/database/desktop.db').existsSync(), isTrue);
    },
  );
}

Future<List<String>> _schemaObjects(Database database) async {
  final rows = await database.rawQuery(
    "SELECT type || ':' || name AS identity FROM sqlite_master "
    "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  return rows.map((row) => row['identity']! as String).toList(growable: false);
}
