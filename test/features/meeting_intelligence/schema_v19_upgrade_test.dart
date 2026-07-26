import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test(
    'v18 to v19 preserves notes and maps legacy processing locations',
    () async {
      sqfliteFfiInit();
      final root = await Directory.systemTemp.createTemp('schema-v19-');
      addTearDown(() => root.delete(recursive: true));
      final path = p.join(root.path, 'upgrade.db');
      var database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 18,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onCreate: (db, _) => _createV18Fixture(db),
        ),
      );
      await database.insert('app_settings', <String, Object?>{
        'id': 1,
        'model_id': 'paraformer-zh',
        'recording_mode': 'standard',
        'auto_transcribe': 1,
        'enable_punctuation': 1,
        'is_dark_mode': 0,
      });
      final recordingId = await database.insert('recordings', <String, Object?>{
        'file_path': '/legacy-v18.m4a',
        'duration_ms': 10000,
        'created_at_ms': 1,
      });
      final generationId = await database
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': '/legacy-v18.m4a',
            'status': 'active',
            'source': 'test',
            'merged_text': 'legacy evidence',
            'created_at_ms': 1,
            'updated_at_ms': 1,
          });
      final segmentId = await database
          .insert('transcript_segments', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': '/legacy-v18.m4a',
            'generation_id': generationId,
            'sequence_id': 0,
            'text': 'legacy evidence',
            'start_ms': 1000,
            'end_ms': 4000,
            'source': 'test',
            'created_at_ms': 1,
            'updated_at_ms': 1,
          });
      final localNote = await _insertNote(
        database,
        recordingId: recordingId,
        generationId: generationId,
        processingLocation: 'local',
        status: 'published',
      );
      await _insertNote(
        database,
        recordingId: recordingId,
        generationId: generationId,
        processingLocation: 'remote',
        status: 'draft',
      );
      final insightId = await database
          .insert('meeting_insights', <String, Object?>{
            'note_id': localNote,
            'kind': 'decision',
            'body': 'Keep this decision.',
            'status': 'published',
            'unsupported': 0,
            'created_at_ms': 1,
            'updated_at_ms': 1,
          });
      await database.insert('evidence_links', <String, Object?>{
        'insight_id': insightId,
        'segment_id': segmentId,
        'start_ms': 1200,
        'end_ms': 3000,
        'created_at_ms': 1,
      });
      await database.close();

      database = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 19,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onUpgrade: (db, oldVersion, newVersion) =>
              AppDatabase.migrateS3Productization(db),
        ),
      );
      addTearDown(database.close);

      final notes = await database.query('meeting_notes', orderBy: 'id');
      expect(notes, hasLength(2));
      expect(notes[0]['processing_location'], 'onDevice');
      expect(notes[0]['status'], 'published');
      expect(
        notes[0]['output_schema_version'],
        'meeting_intelligence_output/v1',
      );
      expect(notes[0]['template_id'], 'general');
      expect(notes[1]['processing_location'], 'cloudDirect');
      expect(await database.query('meeting_insights'), hasLength(1));
      expect(await database.query('evidence_links'), hasLength(1));

      final settings = (await database.query('app_settings')).single;
      expect(settings['meeting_processing_location'], 'onDevice');
      expect(settings['meeting_ai_provider_id'], isNull);
      expect(settings['meeting_ai_model_id'], isNull);
      expect(settings['meeting_ai_secret_configured'], 0);

      for (final table in <String>[
        'meeting_intelligence_jobs',
        'meeting_speakers',
        'speaker_turns',
        'transcript_speaker_assignments',
        'speaker_revisions',
      ]) {
        expect(
          await database.rawQuery(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            <Object>[table],
          ),
          hasLength(1),
          reason: table,
        );
      }
      expect(await database.rawQuery('PRAGMA foreign_key_check'), isEmpty);
      expect(
        (await database.rawQuery('PRAGMA user_version')).single['user_version'],
        19,
      );
    },
  );
}

Future<int> _insertNote(
  Database database, {
  required int recordingId,
  required int generationId,
  required String processingLocation,
  required String status,
}) {
  return database.insert('meeting_notes', <String, Object?>{
    'recording_id': recordingId,
    'generation_id': generationId,
    'status': status,
    'provider_id': 'legacy-fixture',
    'model_id': 'legacy-v1',
    'processing_location': processingLocation,
    'consent_granted': 1,
    'input_start_ms': 0,
    'input_end_ms': 10000,
    'created_at_ms': 1,
    'updated_at_ms': 1,
  });
}

Future<void> _createV18Fixture(Database db) async {
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
      recording_consent_accepted_at_ms INTEGER,
      recently_deleted_retention_days INTEGER,
      retention_last_successful_scan_at_ms INTEGER
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
    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER,
      recording_path TEXT NOT NULL,
      generation_id INTEGER NOT NULL,
      sequence_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id)
        REFERENCES transcript_generations(id) ON DELETE CASCADE
    )
  ''');
  await db.execute('''
    CREATE TABLE meeting_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      processing_location TEXT NOT NULL,
      consent_granted INTEGER NOT NULL,
      input_start_ms INTEGER NOT NULL,
      input_end_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      reviewed_at_ms INTEGER,
      published_at_ms INTEGER,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id)
        REFERENCES transcript_generations(id) ON DELETE CASCADE
    )
  ''');
  await db.execute('''
    CREATE TABLE meeting_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      action_owner TEXT,
      action_due_at_ms INTEGER,
      unresolved_owner INTEGER NOT NULL DEFAULT 0,
      unresolved_due_date INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      unsupported INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      reviewed_at_ms INTEGER,
      rejected_at_ms INTEGER,
      published_at_ms INTEGER,
      FOREIGN KEY(note_id) REFERENCES meeting_notes(id) ON DELETE CASCADE
    )
  ''');
  await db.execute('''
    CREATE TABLE evidence_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insight_id INTEGER NOT NULL,
      segment_id INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(insight_id)
        REFERENCES meeting_insights(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id)
        REFERENCES transcript_segments(id) ON DELETE CASCADE
    )
  ''');
  await db.execute('''
    CREATE TABLE meeting_note_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      insight_id INTEGER,
      previous_body TEXT NOT NULL,
      next_body TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(note_id) REFERENCES meeting_notes(id) ON DELETE CASCADE,
      FOREIGN KEY(insight_id)
        REFERENCES meeting_insights(id) ON DELETE SET NULL
    )
  ''');
}
