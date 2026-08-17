import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test('enqueue is idempotent while a matching job is active', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );

    final first = await repository.enqueue(
      recordingPath: '/audios/one.m4a',
      durationMs: 1000,
      source: 'standard_offline',
    );
    final second = await repository.enqueue(
      recordingPath: '/audios/one.m4a',
      durationMs: 1000,
      source: 'standard_offline',
    );

    expect(first.inserted, isTrue);
    expect(second.inserted, isFalse);
    expect(second.jobId, first.jobId);
    expect(await fixture.database.query('transcription_jobs'), hasLength(1));
  });

  test('claim is FIFO, exclusive, and increments attempts', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final first = await repository.enqueue(
      recordingPath: '/audios/first.m4a',
      durationMs: 1000,
    );
    final second = await repository.enqueue(
      recordingPath: '/audios/second.m4a',
      durationMs: 1000,
    );

    final claimedFirst = await repository.claimNextPending();
    final claimedSecond = await repository.claimNextPending();

    expect(claimedFirst?.id, first.jobId);
    expect(claimedFirst?.attemptCount, 1);
    expect(claimedSecond?.id, second.jobId);
    expect(await repository.claimNextPending(), isNull);
  });

  test('progress is monotonic and pending cancellation is terminal', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final processing = await repository.enqueue(
      recordingPath: '/audios/progress.m4a',
      durationMs: 1000,
    );
    await repository.claimNextPending();

    await repository.updateProgress(
      id: processing.jobId,
      stage: 'vad',
      progress: 0.7,
    );
    await repository.updateProgress(
      id: processing.jobId,
      stage: 'transcode',
      progress: 0.2,
    );

    final progressed = await repository.findById(processing.jobId);
    expect(progressed?.progress, 0.7);
    expect(progressed?.stage, 'vad');

    final pending = await repository.enqueue(
      recordingPath: '/audios/cancel.m4a',
      durationMs: 1000,
    );
    final cancellation = await repository.requestCancellation(pending.jobId);
    final canceled = await repository.findById(pending.jobId);
    expect(cancellation.wasProcessing, isFalse);
    expect(canceled?.status, 'canceled');
    expect(canceled?.failureStage, 'cancellation');
  });

  test('restart requeues only processing jobs absent from native', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final nativeActive = await repository.enqueue(
      recordingPath: '/audios/native-active.m4a',
      durationMs: 1000,
    );
    await repository.claimNextPending();
    final interrupted = await repository.enqueue(
      recordingPath: '/audios/interrupted.m4a',
      durationMs: 1000,
    );
    await repository.claimNextPending();

    expect(
      await repository.requeueInterruptedProcessing(
        activeNativeJobIds: <int>{nativeActive.jobId},
      ),
      1,
    );
    expect(
      (await repository.findById(nativeActive.jobId))?.status,
      'processing',
    );
    expect((await repository.findById(interrupted.jobId))?.status, 'pending');
    expect(
      (await repository.listProcessing(
        jobIds: <int>{nativeActive.jobId},
      )).map((job) => job.id),
      <int>[nativeActive.jobId],
    );
  });

  test(
    'stale processing jobs are requeued and failed jobs can retry',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = TranscriptionJobsRepository(
        database: fixture.appDatabase,
      );
      final stale = await repository.enqueue(
        recordingPath: '/audios/stale.m4a',
        durationMs: 1000,
      );
      await repository.claimNextPending();
      await fixture.database.update(
        'transcription_jobs',
        <String, Object?>{'heartbeat_at_ms': 10, 'updated_at_ms': 10},
        where: 'id = ?',
        whereArgs: <Object>[stale.jobId],
      );

      expect(await repository.requeueStaleProcessing(staleBeforeMs: 20), 1);
      expect((await repository.findById(stale.jobId))?.status, 'pending');

      await repository.claimNextPending();
      await repository.fail(
        id: stale.jobId,
        stage: 'model',
        code: 'MODEL_NOT_READY',
        message: '模型不可用',
      );
      expect(await repository.retry(stale.jobId), isTrue);
      final retried = await repository.findById(stale.jobId);
      expect(retried?.status, 'pending');
      expect(retried?.failureStage, isNull);
      expect(retried?.errorCode, isNull);
    },
  );

  test(
    'batch lookup returns the newest persisted job for each recording',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = TranscriptionJobsRepository(
        database: fixture.appDatabase,
      );
      final first = await repository.enqueue(
        recordingPath: '/audios/repeated.m4a',
        durationMs: 1000,
      );
      await repository.claimNextPending();
      await repository.fail(
        id: first.jobId,
        stage: 'model',
        code: 'MODEL_NOT_READY',
        message: '模型不可用',
      );
      final newest = await repository.enqueue(
        recordingPath: '/audios/repeated.m4a',
        durationMs: 1000,
      );
      final other = await repository.enqueue(
        recordingPath: '/audios/other.m4a',
        durationMs: 2000,
      );

      final jobs = await repository.findLatestByRecordingPaths(<String>[
        '/audios/repeated.m4a',
        ...List<String>.generate(
          501,
          (int index) => '/audios/missing-$index.m4a',
        ),
        '/audios/other.m4a',
      ]);

      expect(jobs['/audios/repeated.m4a']?.id, newest.jobId);
      expect(jobs['/audios/repeated.m4a']?.status, 'pending');
      expect(jobs['/audios/other.m4a']?.id, other.jobId);
      expect(jobs, isNot(contains('/audios/missing-0.m4a')));
    },
  );
}
