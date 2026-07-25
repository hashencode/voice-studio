import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

Future<({Database database, AppDatabase appDatabase})>
openRecordingTestDatabase() async {
  sqfliteFfiInit();
  final Database database = await databaseFactoryFfi.openDatabase(
    inMemoryDatabasePath,
  );
  await database.execute('PRAGMA foreign_keys = ON');
  await database.execute('''
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
  await database.execute('''
    CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY,
      model_id TEXT NOT NULL,
      recording_mode TEXT NOT NULL DEFAULT 'standard',
      auto_transcribe INTEGER NOT NULL,
      is_dark_mode INTEGER NOT NULL DEFAULT 0,
      recording_consent_version INTEGER NOT NULL DEFAULT 0,
      recording_consent_accepted_at_ms INTEGER
    )
  ''');
  await database.execute('''
    CREATE TABLE transcription_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      recording_mode TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'standard_offline',
      failure_stage TEXT,
      stage TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      dedupe_key TEXT,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      result_text TEXT,
      error_message TEXT
    )
  ''');
  await database.execute('''
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
  await AppDatabase.migrateRecordingSessions(database);
  await AppDatabase.migrateManagedMeetingAssets(database);
  await AppDatabase.migrateTranscriptionQueue(database);
  await AppDatabase.migrateTranscriptGenerations(database);
  await AppDatabase.migrateTranscriptRevisions(database);
  await AppDatabase.migrateMeetingIntelligence(database);
  await AppDatabase.migrateTranscriptReviewClosure(database);
  await AppDatabase.migrateRecordingAnnotations(database);
  await AppDatabase.migrateS2Closure(database);
  return (database: database, appDatabase: AppDatabase.forTesting(database));
}
