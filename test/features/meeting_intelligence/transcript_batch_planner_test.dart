import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/transcript_batch_planner.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  test(
    'batches only at segment boundaries and preserves each segment once',
    () {
      const planner = TranscriptBatchPlanner(
        maximumBatchBytes: 10000,
        maximumSegmentsPerBatch: 2,
        maximumReduceInputs: 2,
      );
      final segments = <TranscriptSegmentEntity>[
        _segment(4, 4),
        _segment(1, 1),
        _segment(3, 3),
        _segment(2, 2),
        _segment(5, 5),
      ];

      final plan = planner.plan(segments);

      expect(plan.batches.map((batch) => batch.length), <int>[2, 2, 1]);
      expect(
        plan.batches.expand((batch) => batch).map((segment) => segment.id),
        <int>[1, 2, 3, 4, 5],
      );
      expect(plan.estimatedRequestCount, 6);
      expect(plan.payloadSummary, contains('5 个转写片段'));
      expect(plan.payloadSummary, contains('预计 6 次请求'));
      for (final batch in plan.batches) {
        expect(
          batch.fold<int>(
            0,
            (total, segment) => total + planner.encodedSegmentBytes(segment),
          ),
          lessThanOrEqualTo(planner.maximumBatchBytes),
        );
      }
    },
  );

  test('rejects an individual segment that cannot fit the input budget', () {
    const planner = TranscriptBatchPlanner(maximumBatchBytes: 30);
    expect(
      () => planner.plan(<TranscriptSegmentEntity>[
        _segment(1, 1, text: 'x' * 100),
      ]),
      throwsStateError,
    );
  });

  test('reduction request estimate matches hierarchy groups', () {
    const planner = TranscriptBatchPlanner(maximumReduceInputs: 3);
    expect(planner.estimatedReductionRequestCount(1), 0);
    expect(planner.estimatedReductionRequestCount(2), 1);
    expect(planner.estimatedReductionRequestCount(4), 3);
    expect(
      planner.reductionGroups(<int>[1, 2, 3, 4]).map((group) => group.length),
      <int>[3, 1],
    );
  });
}

TranscriptSegmentEntity _segment(int id, int sequenceId, {String? text}) {
  return TranscriptSegmentEntity(
    id: id,
    recordingPath: '/fixture.wav',
    recordingId: 1,
    generationId: 1,
    jobId: null,
    sequenceId: sequenceId,
    text: text ?? 'segment $id',
    startMs: id * 1000,
    endMs: id * 1000 + 800,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
