import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test('v13 migration preserves completed jobs and legacy segments', () async {
    sqfliteFfiInit();
    final database = await databaseFactoryFfi.openDatabase(
      inMemoryDatabasePath,
    );
    addTearDown(database.close);
    await database.execute('''
      CREATE TABLE recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    ''');
    await database.execute('''
      CREATE TABLE transcription_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_path TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        result_text TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
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
    const path = '/legacy/completed.m4a';
    final recordingId = await database.insert('recordings', <String, Object?>{
      'file_path': path,
      'duration_ms': 3000,
      'created_at_ms': 1,
    });
    final jobId = await database.insert('transcription_jobs', <String, Object?>{
      'recording_path': path,
      'duration_ms': 3000,
      'status': 'completed',
      'source': 'standard_offline',
      'result_text': '旧第一段 旧第二段',
      'created_at_ms': 2,
      'updated_at_ms': 3,
    });
    for (var index = 0; index < 2; index += 1) {
      await database.insert('transcript_segments', <String, Object?>{
        'recording_path': path,
        'job_id': jobId,
        'sequence_id': index,
        'text': index == 0 ? '旧第一段' : '旧第二段',
        'start_ms': index * 1500,
        'end_ms': (index + 1) * 1000,
        'is_final': 1,
        'source': 'standard_offline',
        'confidence': null,
        'created_at_ms': 3,
        'updated_at_ms': 3,
      });
    }
    await database.insert('transcript_segments', <String, Object?>{
      'recording_path': '/legacy/orphan.m4a',
      'job_id': 999,
      'sequence_id': 0,
      'text': '孤立片段仍需保留',
      'start_ms': 0,
      'end_ms': 1000,
      'is_final': 1,
      'source': 'legacy',
      'confidence': null,
      'created_at_ms': 4,
      'updated_at_ms': 4,
    });

    await AppDatabase.migrateTranscriptGenerations(database);
    await AppDatabase.migrateTranscriptGenerations(database);

    final recording = (await database.query(
      'recordings',
      where: 'id = ?',
      whereArgs: <Object>[recordingId],
    )).single;
    final job = (await database.query(
      'transcription_jobs',
      where: 'id = ?',
      whereArgs: <Object>[jobId],
    )).single;
    final generations = await database.query('transcript_generations');
    final segments = await database.query(
      'transcript_segments',
      orderBy: 'sequence_id ASC',
    );

    expect(generations, hasLength(2));
    final active = generations.singleWhere(
      (generation) => generation['status'] == 'active',
    );
    final orphaned = generations.singleWhere(
      (generation) => generation['status'] == 'orphaned',
    );
    expect(active['merged_text'], '旧第一段 旧第二段');
    expect(orphaned['merged_text'], '孤立片段仍需保留');
    expect(orphaned['job_id'], isNull);
    expect(recording['active_generation_id'], active['id']);
    expect(job['recording_id'], recordingId);
    expect(job['result_text'], '旧第一段 旧第二段');
    expect(segments, hasLength(3));
    expect(
      segments
          .where((segment) => segment['recording_path'] == path)
          .map((segment) => segment['generation_id'])
          .toSet(),
      <Object?>{active['id']},
    );
    expect(
      segments.singleWhere(
        (segment) => segment['recording_path'] == '/legacy/orphan.m4a',
      )['job_id'],
      isNull,
    );
  });
}
