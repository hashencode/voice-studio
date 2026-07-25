import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test('v15 upgrade is atomic and preserves transcript review data', () async {
    sqfliteFfiInit();
    final root = await Directory.systemTemp.createTemp('schema-v16-');
    addTearDown(() => root.delete(recursive: true));
    final path = p.join(root.path, 'upgrade.db');
    var database = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 15,
        onCreate: (db, _) => _createV15Fixture(db),
      ),
    );
    await database.insert('app_settings', <String, Object?>{
      'id': 1,
      'model_id': 'paraformer-zh',
      'auto_transcribe': 1,
    });
    final recordingId = await database.insert('recordings', <String, Object?>{
      'file_path': '/legacy-v15.m4a',
      'duration_ms': 3000,
      'created_at_ms': 1,
    });
    final generationId = await database
        .insert('transcript_generations', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': '/legacy-v15.m4a',
          'status': 'active',
          'source': 'test',
          'merged_text': 'legacy text',
          'created_at_ms': 1,
          'updated_at_ms': 1,
        });
    final segmentId = await database
        .insert('transcript_segments', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': '/legacy-v15.m4a',
          'generation_id': generationId,
          'sequence_id': 0,
          'text': 'legacy text',
          'start_ms': 100,
          'end_ms': 2000,
          'source': 'test',
          'confidence': 0.42,
          'created_at_ms': 1,
          'updated_at_ms': 1,
        });
    await database.insert('transcript_revisions', <String, Object?>{
      'recording_id': recordingId,
      'generation_id': generationId,
      'segment_id': segmentId,
      'previous_text': 'legacy',
      'next_text': 'legacy text',
      'created_at_ms': 1,
    });
    await database.close();

    await expectLater(
      () => databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 16,
          onUpgrade: (db, oldVersion, newVersion) async {
            await AppDatabase.migrateTranscriptReviewClosure(db);
            throw StateError('injected v16 failure');
          },
        ),
      ),
      throwsA(anything),
    );

    database = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(version: 15),
    );
    expect(
      await database.rawQuery('PRAGMA user_version'),
      <Map<String, Object?>>[
        <String, Object?>{'user_version': 15},
      ],
    );
    expect(
      _columnNames(await database.rawQuery('PRAGMA table_info(app_settings)')),
      isNot(contains('enable_punctuation')),
    );
    expect(
      _columnNames(
        await database.rawQuery('PRAGMA table_info(transcript_segments)'),
      ),
      isNot(contains('review_state')),
    );
    await database.close();

    database = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 16,
        onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
        onUpgrade: (db, oldVersion, newVersion) =>
            AppDatabase.migrateTranscriptReviewClosure(db),
      ),
    );
    addTearDown(database.close);

    expect(
      (await database.query('app_settings')).single['enable_punctuation'],
      1,
    );
    final segment = (await database.query('transcript_segments')).single;
    expect(segment['text'], 'legacy text');
    expect(segment['start_ms'], 100);
    expect(segment['end_ms'], 2000);
    expect(segment['confidence'], 0.42);
    expect(segment['review_state'], 'unreviewed');
    expect(segment['reviewed_at_ms'], isNull);
    expect(
      (await database.query(
        'transcript_revisions',
      )).single['invalidated_at_ms'],
      isNull,
    );
    expect(
      _indexNames(
        await database.rawQuery('PRAGMA index_list(transcript_segments)'),
      ),
      contains('transcript_segments_review_time'),
    );
    expect(
      _indexNames(
        await database.rawQuery('PRAGMA index_list(transcript_revisions)'),
      ),
      contains('transcript_revisions_redo_order'),
    );
    await expectLater(
      () => database.update(
        'transcript_segments',
        <String, Object?>{'review_state': 'invalid'},
        where: 'id = ?',
        whereArgs: <Object>[segmentId],
      ),
      throwsA(anything),
    );
  });
}

Set<Object?> _columnNames(List<Map<String, Object?>> rows) {
  return rows.map((row) => row['name']).toSet();
}

Set<Object?> _indexNames(List<Map<String, Object?>> rows) {
  return rows.map((row) => row['name']).toSet();
}

Future<void> _createV15Fixture(Database db) async {
  await db.execute('''
    CREATE TABLE recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      active_generation_id INTEGER,
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
      is_dark_mode INTEGER NOT NULL DEFAULT 0,
      recording_consent_version INTEGER NOT NULL DEFAULT 0,
      recording_consent_accepted_at_ms INTEGER
    )
  ''');
  await db.execute('''
    CREATE TABLE transcription_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  ''');
  await db.execute('''
    CREATE TABLE transcript_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER,
      recording_path TEXT NOT NULL,
      job_id INTEGER,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      merged_text TEXT NOT NULL,
      has_user_edits INTEGER NOT NULL DEFAULT 0,
      has_evidence_links INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      activated_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(job_id) REFERENCES transcription_jobs(id) ON DELETE SET NULL
    )
  ''');
  await db.execute('''
    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER,
      recording_path TEXT NOT NULL,
      generation_id INTEGER NOT NULL,
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
      UNIQUE(generation_id, sequence_id),
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
      FOREIGN KEY(job_id) REFERENCES transcription_jobs(id) ON DELETE SET NULL
    )
  ''');
  await db.execute('''
    CREATE TABLE transcript_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      segment_id INTEGER NOT NULL,
      previous_text TEXT NOT NULL,
      next_text TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      reverted_at_ms INTEGER,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
    )
  ''');
}
