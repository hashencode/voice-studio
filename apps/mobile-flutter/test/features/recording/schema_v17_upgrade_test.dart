import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test(
    'v16 upgrade adds annotations without changing existing sessions',
    () async {
      sqfliteFfiInit();
      final root = await Directory.systemTemp.createTemp('schema-v17-');
      addTearDown(() => root.delete(recursive: true));
      final path = p.join(root.path, 'upgrade.db');
      var database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 16,
          onCreate: (db, _) => _createV16Fixture(db),
        ),
      );
      await database.insert('recording_sessions', <String, Object?>{
        'session_id': 'legacy-session',
        'state': 'completed',
        'canonical_path': '/legacy.m4a',
        'duration_ms': 4_000,
        'created_at_ms': 1,
        'updated_at_ms': 2,
      });
      await database.close();

      database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 17,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onUpgrade: (db, oldVersion, newVersion) =>
              AppDatabase.migrateRecordingAnnotations(db),
        ),
      );
      addTearDown(database.close);

      expect(await database.query('recording_sessions'), hasLength(1));
      expect(
        (await database.query('recording_sessions')).single['session_id'],
        'legacy-session',
      );
      expect(
        await database.rawQuery(
          "SELECT name FROM sqlite_master "
          "WHERE type = 'table' AND name = 'recording_annotations'",
        ),
        hasLength(1),
      );
      expect(
        (await database.rawQuery(
          'PRAGMA index_list(recording_annotations)',
        )).map((row) => row['name']),
        containsAll(<String>[
          'recording_annotations_session_time',
          'recording_annotations_single_note',
        ]),
      );
    },
  );
}

Future<void> _createV16Fixture(Database db) async {
  await db.execute('''
    CREATE TABLE recording_sessions (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      staging_path TEXT,
      canonical_path TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT,
      error_category TEXT,
      native_created_at_ms INTEGER,
      native_updated_at_ms INTEGER,
      recording_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  ''');
}
