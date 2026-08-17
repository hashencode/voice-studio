import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test(
    'v17 to v18 preserves meetings, annotations, generations, settings, and foreign keys',
    () async {
      sqfliteFfiInit();
      final root = await Directory.systemTemp.createTemp('schema-v18-');
      addTearDown(() => root.delete(recursive: true));
      final path = p.join(root.path, 'upgrade.db');
      var database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 17,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onCreate: (db, _) => _createV17Fixture(db),
        ),
      );
      await database.insert('app_settings', <String, Object?>{
        'id': 1,
        'model_id': 'paraformer-zh',
        'recording_mode': 'standard',
        'auto_transcribe': 0,
        'enable_punctuation': 0,
        'is_dark_mode': 1,
        'recording_consent_version': 5,
        'recording_consent_accepted_at_ms': 1234,
      });
      final recordingId = await database.insert('recordings', <String, Object?>{
        'file_path': '/legacy-v17.m4a',
        'duration_ms': 3000,
        'created_at_ms': 1,
      });
      await database.insert('transcript_generations', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': '/legacy-v17.m4a',
        'status': 'active',
        'source': 'test',
        'merged_text': 'legacy text',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
      await database.insert('recording_sessions', <String, Object?>{
        'session_id': 'legacy-session',
        'state': 'completed',
        'recording_id': recordingId,
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
      await database.insert('recording_annotations', <String, Object?>{
        'session_id': 'legacy-session',
        'kind': 'marker',
        'position_ms': 500,
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
      await database.close();

      database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 18,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onUpgrade: (db, oldVersion, newVersion) =>
              AppDatabase.migrateS2Closure(db),
        ),
      );
      addTearDown(database.close);

      final settings = (await database.query('app_settings')).single;
      expect(settings['auto_transcribe'], 0);
      expect(settings['enable_punctuation'], 0);
      expect(settings['is_dark_mode'], 1);
      expect(settings['recording_consent_version'], 5);
      expect(settings['recording_consent_accepted_at_ms'], 1234);
      expect(settings['recently_deleted_retention_days'], isNull);
      expect(settings['retention_last_successful_scan_at_ms'], isNull);
      expect(await database.query('recordings'), hasLength(1));
      expect(await database.query('transcript_generations'), hasLength(1));
      expect(await database.query('recording_sessions'), hasLength(1));
      expect(await database.query('recording_annotations'), hasLength(1));
      expect(await database.rawQuery('PRAGMA foreign_key_check'), isEmpty);
      expect(
        (await database.rawQuery('PRAGMA user_version')).single['user_version'],
        18,
      );
    },
  );
}

Future<void> _createV17Fixture(Database db) async {
  await db.execute('''
    CREATE TABLE recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  ''');
  await db.execute('''
    CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY,
      model_id TEXT NOT NULL,
      recording_mode TEXT NOT NULL DEFAULT 'standard',
      auto_transcribe INTEGER NOT NULL,
      enable_punctuation INTEGER NOT NULL DEFAULT 1,
      is_dark_mode INTEGER NOT NULL DEFAULT 0,
      recording_consent_version INTEGER NOT NULL DEFAULT 0,
      recording_consent_accepted_at_ms INTEGER
    )
  ''');
  await db.execute('''
    CREATE TABLE transcript_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER,
      recording_path TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      merged_text TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
    )
  ''');
  await db.execute('''
    CREATE TABLE recording_sessions (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      recording_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(recording_id) REFERENCES recordings(id)
    )
  ''');
  await db.execute('''
    CREATE TABLE recording_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position_ms INTEGER NOT NULL,
      text TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(session_id)
        REFERENCES recording_sessions(session_id)
        ON DELETE CASCADE
    )
  ''');
}
