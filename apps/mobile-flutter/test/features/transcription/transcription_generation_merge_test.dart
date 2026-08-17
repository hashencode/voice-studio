import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'retry replaces an unedited active generation transactionally',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      const path = '/audios/retry-generation.m4a';
      final recordingId = await _insertRecording(
        fixture.appDatabase,
        fixture.database,
        path,
      );
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      final generations = TranscriptGenerationsRepository(
        database: fixture.appDatabase,
      );

      final firstJob = await _claim(jobs, path);
      final first = await generations.persistCompletedResult(
        job: firstJob,
        result: _single('第一版'),
      );
      final secondJob = await _claim(jobs, path);
      final second = await generations.persistCompletedResult(
        job: secondJob,
        result: _single('第二版'),
      );

      expect(first.activated, isTrue);
      expect(second.activated, isTrue);
      final all = await generations.listForRecording(recordingId);
      expect(all, hasLength(2));
      expect(all.first.status, 'active');
      expect(all.first.mergedText, '第二版');
      expect(all.last.status, 'superseded');
      expect(
        (await generations.findActiveForRecording(recordingId))?.id,
        second.generation.id,
      );
    },
  );

  test(
    'edited or evidence-linked active text is never silently replaced',
    () async {
      for (final protection in <String>['edit', 'evidence']) {
        final fixture = await openRecordingTestDatabase();
        try {
          final path = '/audios/protected-$protection.m4a';
          final recordingId = await _insertRecording(
            fixture.appDatabase,
            fixture.database,
            path,
          );
          final jobs = TranscriptionJobsRepository(
            database: fixture.appDatabase,
          );
          final generations = TranscriptGenerationsRepository(
            database: fixture.appDatabase,
          );
          final first = await generations.persistCompletedResult(
            job: await _claim(jobs, path),
            result: _single('用户保留文本'),
          );
          if (protection == 'edit') {
            await generations.markHasUserEdits(first.generation.id);
          } else {
            await generations.markHasEvidenceLinks(first.generation.id);
          }

          final candidate = await generations.persistCompletedResult(
            job: await _claim(jobs, path),
            result: _single('重试候选文本'),
          );

          expect(candidate.activated, isFalse);
          expect(candidate.replacementBlocked, isTrue);
          expect(candidate.generation.status, 'conflict');
          final active = await generations.findActiveForRecording(recordingId);
          expect(active?.id, first.generation.id);
          expect(active?.mergedText, '用户保留文本');
        } finally {
          await fixture.database.close();
        }
      }
    },
  );

  test(
    'segment insert failure rolls back candidate and job completion',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      const path = '/audios/rollback.m4a';
      await _insertRecording(fixture.appDatabase, fixture.database, path);
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      final job = await _claim(jobs, path);
      await fixture.database.execute('''
      CREATE TRIGGER fail_segment_insert
      BEFORE INSERT ON transcript_segments
      WHEN NEW.recording_path = '$path'
      BEGIN
        SELECT RAISE(ABORT, 'simulated segment persistence failure');
      END
    ''');
      final generations = TranscriptGenerationsRepository(
        database: fixture.appDatabase,
      );

      await expectLater(
        generations.persistCompletedResult(job: job, result: _single('回滚文本')),
        throwsA(anything),
      );

      expect(
        await fixture.database.query(
          'transcript_generations',
          where: 'recording_path = ?',
          whereArgs: <Object>[path],
        ),
        isEmpty,
      );
      expect(
        await fixture.database.query(
          'transcript_segments',
          where: 'recording_path = ?',
          whereArgs: <Object>[path],
        ),
        isEmpty,
      );
      expect((await jobs.findById(job.id))?.status, 'processing');
    },
  );
}

Future<int> _insertRecording(
  AppDatabase appDatabase,
  Database database,
  String path,
) async {
  await RecordingsRepository(
    database: appDatabase,
  ).insert(filePath: path, durationMs: 3000);
  final rows = await database.query(
    'recordings',
    where: 'file_path = ?',
    whereArgs: <Object>[path],
  );
  return rows.single['id'] as int;
}

Future<TranscriptionJobEntity> _claim(
  TranscriptionJobsRepository jobs,
  String path,
) async {
  await jobs.enqueue(recordingPath: path, durationMs: 3000);
  return (await jobs.claimNextPending())!;
}

TranscriptionResult _single(String text) {
  return TranscriptionResult.singleText(text, durationMs: 3000);
}
