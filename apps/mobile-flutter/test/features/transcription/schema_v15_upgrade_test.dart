import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test(
    'schema 9 upgrade preserves data and failed upgrade rolls back',
    () async {
      sqfliteFfiInit();
      final root = await Directory.systemTemp.createTemp('schema-v15-');
      addTearDown(() => root.delete(recursive: true));
      final path = p.join(root.path, 'upgrade.db');
      var database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 9,
          onCreate: (db, _) => _createV9(db),
        ),
      );
      await database.insert('recordings', <String, Object?>{
        'file_path': '/legacy.m4a',
        'duration_ms': 3000,
        'created_at_ms': 1,
      });
      await database.insert('transcription_jobs', <String, Object?>{
        'recording_path': '/legacy.m4a',
        'duration_ms': 3000,
        'status': 'completed',
        'recording_mode': 'standard',
        'source': 'standard_offline',
        'created_at_ms': 1,
        'updated_at_ms': 2,
        'result_text': 'legacy text',
      });
      await database.insert('transcript_segments', <String, Object?>{
        'recording_path': '/legacy.m4a',
        'job_id': 1,
        'sequence_id': 0,
        'text': 'legacy text',
        'start_ms': 0,
        'end_ms': 3000,
        'source': 'standard_offline',
        'created_at_ms': 2,
        'updated_at_ms': 2,
      });
      await database.close();

      await expectLater(
        () => databaseFactoryFfi.openDatabase(
          path,
          options: OpenDatabaseOptions(
            version: 15,
            onUpgrade: (db, oldVersion, newVersion) async {
              await _upgradeToV15(db);
              throw StateError('injected migration failure');
            },
          ),
        ),
        throwsA(anything),
      );

      database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(version: 9),
      );
      expect(
        (await database.query('recordings')).single['file_path'],
        '/legacy.m4a',
      );
      expect(
        (await database.query('transcription_jobs')).single['result_text'],
        'legacy text',
      );
      expect(
        await database.rawQuery('PRAGMA user_version'),
        <Map<String, Object?>>[
          <String, Object?>{'user_version': 9},
        ],
      );
      expect(
        await database.rawQuery(
          "SELECT name FROM sqlite_master "
          "WHERE type='table' AND name='meeting_notes'",
        ),
        isEmpty,
      );
      await database.close();

      database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 15,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onUpgrade: (db, oldVersion, newVersion) => _upgradeToV15(db),
        ),
      );
      addTearDown(database.close);
      expect((await database.query('recordings')), hasLength(1));
      expect(
        (await database.query('transcription_jobs')).single['result_text'],
        'legacy text',
      );
      expect((await database.query('transcript_segments')), hasLength(1));
      for (final table in <String>[
        'transcript_generations',
        'transcript_revisions',
        'meeting_notes',
        'meeting_insights',
        'evidence_links',
        'meeting_note_revisions',
      ]) {
        expect(
          await database.rawQuery(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            <Object>[table],
          ),
          hasLength(1),
          reason: table,
        );
      }
      expect(
        (await database.rawQuery('PRAGMA foreign_keys')).single['foreign_keys'],
        1,
      );
    },
  );
}

Future<void> _upgradeToV15(Database db) async {
  await AppDatabase.migrateRecordingSessions(db);
  await AppDatabase.migrateManagedMeetingAssets(db);
  await AppDatabase.migrateTranscriptionQueue(db);
  await AppDatabase.migrateTranscriptGenerations(db);
  await AppDatabase.migrateTranscriptRevisions(db);
  await AppDatabase.migrateMeetingIntelligence(db);
}

Future<void> _createV9(Database db) async {
  await db.execute('''
    CREATE TABLE recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      display_name TEXT,
      group_name TEXT,
      deleted_at_ms INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
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
      is_dark_mode INTEGER NOT NULL DEFAULT 0
    )
  ''');
  await db.execute('''
    CREATE TABLE transcription_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      recording_mode TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'standard_offline',
      failure_stage TEXT,
      progress REAL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      result_text TEXT,
      error_message TEXT
    )
  ''');
  await db.execute('''
    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_path TEXT NOT NULL,
      job_id INTEGER,
      sequence_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      confidence REAL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(recording_path, sequence_id)
    )
  ''');
}
