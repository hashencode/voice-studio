import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_job_reconciler.dart';

import '../recording/recording_test_database.dart';

void main() {
  test('startup reconciler requeues only stale processing work', () async {
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
      <String, Object?>{'heartbeat_at_ms': 100, 'updated_at_ms': 100},
      where: 'id = ?',
      whereArgs: <Object>[stale.jobId],
    );
    final fresh = await repository.enqueue(
      recordingPath: '/audios/fresh.m4a',
      durationMs: 1000,
    );
    await repository.claimNextPending();
    await fixture.database.update(
      'transcription_jobs',
      <String, Object?>{'heartbeat_at_ms': 900, 'updated_at_ms': 900},
      where: 'id = ?',
      whereArgs: <Object>[fresh.jobId],
    );
    final reconciler = TranscriptionJobReconciler(
      repository: repository,
      nowMs: () => 1000,
      staleAfter: const Duration(milliseconds: 500),
    );

    expect(await reconciler.reconcile(), 1);
    expect((await repository.findById(stale.jobId))?.status, 'pending');
    expect((await repository.findById(fresh.jobId))?.status, 'processing');
  });
}
