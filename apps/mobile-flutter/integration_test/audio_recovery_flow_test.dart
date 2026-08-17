import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/records/service/audio_deletion_coordinator.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_job_reconciler.dart';

import 'audio_test_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'stale queue resumes, persists structured result, and deletion retries',
    (tester) async {
      final harness = await AudioIntegrationHarness.create('recovery-flow');
      addTearDown(harness.dispose);
      final recordings = RecordingsRepository(database: harness.appDatabase);
      final recordingId = await harness.database.insert(
        'recordings',
        <String, Object?>{
          'file_path': harness.audioFile.path,
          'duration_ms': 5000,
          'created_at_ms': 1,
        },
      );
      final jobs = TranscriptionJobsRepository(database: harness.appDatabase);
      final queued = await jobs.enqueue(
        recordingPath: harness.audioFile.path,
        durationMs: 5000,
      );
      expect(queued.inserted, isTrue);
      final firstAttempt = await jobs.claimNextPending();
      expect(firstAttempt?.attemptCount, 1);
      await harness.database.update(
        'transcription_jobs',
        <String, Object?>{'heartbeat_at_ms': 0},
        where: 'id = ?',
        whereArgs: <Object>[queued.jobId],
      );
      final requeued = await TranscriptionJobReconciler(
        repository: jobs,
        nowMs: () => 600000,
        staleAfter: const Duration(minutes: 2),
      ).reconcile();
      expect(requeued, 1);
      final resumed = await jobs.claimNextPending();
      expect(resumed?.attemptCount, 2);
      await TranscriptGenerationsRepository(
        database: harness.appDatabase,
      ).persistCompletedResult(
        job: resumed!,
        result: TranscriptionResult.singleText(
          'Recovered transcript',
          durationMs: 5000,
        ),
      );
      expect((await jobs.findById(queued.jobId))?.status, 'completed');
      final activeGeneration = await harness.database.query(
        'recordings',
        columns: <String>['active_generation_id'],
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
      expect(activeGeneration.single['active_generation_id'], isNotNull);

      final exportPath = '${harness.root.path}/export.txt';
      await recordings.registerOwnedAsset(
        recordingId: recordingId,
        path: exportPath,
        kind: 'transcript_export',
      );
      final fileStore = _RetryFileStore();
      final deletion = AudioDeletionCoordinator(
        recordingsRepository: recordings,
        fileStore: fileStore,
      );
      final failed = await deletion.permanentlyDelete(recordingId);
      expect(failed.completed, isFalse);
      expect(
        (await recordings.findById(recordingId))?.deletionState,
        'pending',
      );

      fileStore.allowDeletes = true;
      final completed = await deletion.permanentlyDelete(recordingId);
      expect(completed.completed, isTrue);
      expect(await recordings.findById(recordingId), isNull);
      expect(
        (await harness.database.rawQuery(
          'SELECT COUNT(*) AS count FROM transcript_generations',
        )).single['count'],
        0,
      );
    },
  );
}

class _RetryFileStore implements AudioFileStore {
  bool allowDeletes = false;

  @override
  Future<bool> deleteIfPresent(String path) async => allowDeletes;
}
