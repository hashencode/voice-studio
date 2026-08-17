import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_segments_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test('active generation exposes ordered segments and merged text', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recordings = RecordingsRepository(database: fixture.appDatabase);
    const path = '/audios/segments.m4a';
    await recordings.insert(filePath: path, durationMs: 3000);
    final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
    final queued = await jobs.enqueue(recordingPath: path, durationMs: 3000);
    final job = await jobs.claimNextPending();
    final generations = TranscriptGenerationsRepository(
      database: fixture.appDatabase,
    );
    await generations.persistCompletedResult(
      job: job!,
      result: _result('第一段', '第二段'),
    );
    final segments = TranscriptSegmentsRepository(
      database: fixture.appDatabase,
    );

    final listed = await segments.listForRecordingPath(path);

    expect(queued.jobId, job.id);
    expect(listed.map((segment) => segment.sequenceId), <int>[0, 1]);
    expect(listed.map((segment) => segment.text), <String>['第一段', '第二段']);
    expect(listed.first.generationId, greaterThan(0));
    expect(listed.first.recordingId, isNotNull);
    expect(listed.last.confidence, isNull);
    expect(listed.last.reviewState, TranscriptReviewState.unreviewed);
    expect(listed.last.reviewedAtMs, isNull);
    expect(await segments.mergedTextForRecordingPath(path), '第一段\n第二段');
  });

  test(
    'review state transitions persist and only reviewed has a timestamp',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recordings = RecordingsRepository(database: fixture.appDatabase);
      const path = '/audios/review-state.m4a';
      await recordings.insert(filePath: path, durationMs: 3000);
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      await jobs.enqueue(recordingPath: path, durationMs: 3000);
      final job = await jobs.claimNextPending();
      final generations = TranscriptGenerationsRepository(
        database: fixture.appDatabase,
      );
      await generations.persistCompletedResult(
        job: job!,
        result: _result('待确认', '已确认'),
      );
      final repository = TranscriptSegmentsRepository(
        database: fixture.appDatabase,
      );
      final initial = await repository.listForRecordingPath(path);

      expect(await repository.markNeedsReview(initial.first.id), isTrue);
      var updated = await repository.listForRecordingPath(path);
      expect(updated.first.reviewState, TranscriptReviewState.needsReview);
      expect(updated.first.reviewedAtMs, isNull);
      expect(updated.first.confidence, 0.42);

      expect(await repository.markReviewed(initial.first.id), isTrue);
      updated = await repository.listForRecordingPath(path);
      expect(updated.first.reviewState, TranscriptReviewState.reviewed);
      expect(updated.first.reviewedAtMs, isNotNull);
      expect(updated.first.confidence, 0.42);
      expect(updated.first.startMs, initial.first.startMs);
      expect(updated.first.endMs, initial.first.endMs);

      expect(await repository.markUnreviewed(initial.first.id), isTrue);
      updated = await repository.listForRecordingPath(path);
      expect(updated.first.reviewState, TranscriptReviewState.unreviewed);
      expect(updated.first.reviewedAtMs, isNull);
      expect(updated.first.confidence, 0.42);
      expect(await repository.markReviewed(-1), isFalse);
      expect(
        await repository.markReviewed(
          initial.last.id,
          generationId: initial.first.generationId + 1,
        ),
        isFalse,
      );
      updated = await repository.listForRecordingPath(path);
      expect(updated.last.reviewState, TranscriptReviewState.unreviewed);
    },
  );
}

TranscriptionResult _result(String first, String second) {
  return TranscriptionResult(
    mergedText: '$first $second',
    segments: <TranscriptionSegmentResult>[
      TranscriptionSegmentResult(
        sequenceId: 0,
        text: first,
        startMs: 100,
        endMs: 1000,
        confidence: 0.42,
      ),
      TranscriptionSegmentResult(
        sequenceId: 1,
        text: second,
        startMs: 1500,
        endMs: 2500,
      ),
    ],
  );
}
