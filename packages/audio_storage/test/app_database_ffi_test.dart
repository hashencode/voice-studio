import 'dart:io';

import 'package:audio_storage/audio_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test(
    'fresh-create opens the Audio v1 schema without upgrade hooks',
    () async {
      final root = await Directory.systemTemp.createTemp('audio-storage-');
      addTearDown(() => root.delete(recursive: true));

      final freshOwner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
        databaseName: 'fresh.db',
      );
      final fresh = await freshOwner.database;
      addTearDown(fresh.close);

      expect(await fresh.rawQuery('PRAGMA foreign_key_check'), isEmpty);
      expect(
        (await fresh.rawQuery('PRAGMA user_version')).single['user_version'],
        AudioStorageContract.schemaVersion,
      );
      expect(AppDatabase.schemaVersion, 1);
      expect(await _schemaObjects(fresh), contains('table:audio_notes'));
      expect(await _schemaObjects(fresh), contains('table:audio_insights'));
      expect(
        await _schemaObjects(fresh),
        contains('table:audio_intelligence_jobs'),
      );
    },
  );

  test(
    'first Audio open archives the retired database and sidecars without loading it',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'audio-storage-archive-',
      );
      addTearDown(() => root.delete(recursive: true));
      final retiredPath =
          '${root.path}/${AudioStorageContract.retiredDatabaseFileName}';
      final retired = await databaseFactoryFfi.openDatabase(retiredPath);
      await retired.execute(
        'CREATE TABLE retired_records (value TEXT NOT NULL)',
      );
      await retired.insert('retired_records', <String, Object?>{
        'value': 'retired-only',
      });
      await retired.close();
      final sidecarContents = <String, List<int>>{
        '-wal': <int>[1, 2, 3],
        '-shm': <int>[4, 5, 6],
        '-journal': <int>[7, 8, 9],
      };
      for (final entry in sidecarContents.entries) {
        await File('$retiredPath${entry.key}').writeAsBytes(entry.value);
      }

      final owner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
      );
      final audio = await owner.database;
      addTearDown(audio.close);

      expect(await audio.query('recordings'), isEmpty);
      expect(await File(retiredPath).exists(), isFalse);
      for (final suffix in sidecarContents.keys) {
        expect(await File('$retiredPath$suffix').exists(), isFalse);
      }

      final archiveRoot = Directory(
        '${root.path}/${AudioStorageContract.archiveDirectoryName}',
      );
      final archives = await archiveRoot
          .list()
          .where((entity) => entity is Directory)
          .cast<Directory>()
          .toList();
      expect(archives, hasLength(1));
      final archivedRetiredPath =
          '${archives.single.path}/${AudioStorageContract.retiredDatabaseFileName}';
      expect(await File(archivedRetiredPath).exists(), isTrue);
      for (final entry in sidecarContents.entries) {
        final archivedSidecar = File('$archivedRetiredPath${entry.key}');
        expect(await archivedSidecar.readAsBytes(), entry.value);
        await archivedSidecar.delete();
      }
      final archived = await databaseFactoryFfi.openDatabase(
        archivedRetiredPath,
        options: OpenDatabaseOptions(readOnly: true),
      );
      addTearDown(archived.close);
      expect(await archived.query('retired_records'), <Map<String, Object?>>[
        <String, Object?>{'value': 'retired-only'},
      ]);
    },
  );

  test(
    'archive failure preserves the retired database and blocks Audio creation',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'audio-storage-archive-failure-',
      );
      addTearDown(() => root.delete(recursive: true));
      final retired = File(
        '${root.path}/${AudioStorageContract.retiredDatabaseFileName}',
      );
      const retiredBytes = <int>[10, 20, 30, 40];
      await retired.writeAsBytes(retiredBytes);
      await File(
        '${root.path}/${AudioStorageContract.archiveDirectoryName}',
      ).writeAsString('blocks archive directory creation');
      final owner = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => root.path,
      );

      await expectLater(owner.database, throwsA(isA<FileSystemException>()));

      expect(await retired.readAsBytes(), retiredBytes);
      expect(
        await File(
          '${root.path}/${AudioStorageContract.databaseFileName}',
        ).exists(),
        isFalse,
      );
    },
  );

  test(
    'desktop factory owns a database below its app support directory',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'audio-storage-support-',
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
          <String, Object?>{'user_version': AudioStorageContract.schemaVersion},
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
