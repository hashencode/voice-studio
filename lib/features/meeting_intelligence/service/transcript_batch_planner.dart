import 'dart:convert';

import '../../transcription/model/transcript_segment_entity.dart';

class TranscriptBatchPlan {
  const TranscriptBatchPlan({
    required this.batches,
    required this.estimatedRequestCount,
    required this.payloadSummary,
  });

  final List<List<TranscriptSegmentEntity>> batches;
  final int estimatedRequestCount;
  final String payloadSummary;
}

class TranscriptBatchPlanner {
  const TranscriptBatchPlanner({
    this.maximumBatchBytes = 24 * 1024,
    this.maximumSegmentsPerBatch = 80,
    this.maximumReduceInputs = 8,
  });

  final int maximumBatchBytes;
  final int maximumSegmentsPerBatch;
  final int maximumReduceInputs;

  TranscriptBatchPlan plan(List<TranscriptSegmentEntity> segments) {
    if (segments.isEmpty) {
      throw ArgumentError.value(segments, 'segments', '转写片段不能为空');
    }
    final ordered = List<TranscriptSegmentEntity>.of(segments)
      ..sort((left, right) {
        final bySequence = left.sequenceId.compareTo(right.sequenceId);
        if (bySequence != 0) return bySequence;
        final byStart = left.startMs.compareTo(right.startMs);
        return byStart != 0 ? byStart : left.id.compareTo(right.id);
      });
    final batches = <List<TranscriptSegmentEntity>>[];
    var current = <TranscriptSegmentEntity>[];
    var currentBytes = 0;
    for (final segment in ordered) {
      final segmentBytes = encodedSegmentBytes(segment);
      if (segmentBytes > maximumBatchBytes) {
        throw StateError('单个转写片段超过云端输入预算');
      }
      final wouldOverflow =
          current.isNotEmpty &&
          (current.length >= maximumSegmentsPerBatch ||
              currentBytes + segmentBytes > maximumBatchBytes);
      if (wouldOverflow) {
        batches.add(List<TranscriptSegmentEntity>.unmodifiable(current));
        current = <TranscriptSegmentEntity>[];
        currentBytes = 0;
      }
      current.add(segment);
      currentBytes += segmentBytes;
    }
    if (current.isNotEmpty) {
      batches.add(List<TranscriptSegmentEntity>.unmodifiable(current));
    }
    final requestCount =
        batches.length + estimatedReductionRequestCount(batches.length);
    final startMs = ordered
        .map((segment) => segment.startMs)
        .reduce((left, right) => left < right ? left : right);
    final endMs = ordered
        .map((segment) => segment.endMs)
        .reduce((left, right) => left > right ? left : right);
    return TranscriptBatchPlan(
      batches: List<List<TranscriptSegmentEntity>>.unmodifiable(batches),
      estimatedRequestCount: requestCount,
      payloadSummary:
          '${ordered.length} 个转写片段，'
          '${_clock(startMs)}–${_clock(endMs)}，预计 $requestCount 次请求',
    );
  }

  int encodedSegmentBytes(TranscriptSegmentEntity segment) {
    return utf8
        .encode(
          jsonEncode(<String, Object?>{
            'segment_id': segment.id,
            'start_ms': segment.startMs,
            'end_ms': segment.endMs,
            'text': segment.text,
          }),
        )
        .length;
  }

  int estimatedReductionRequestCount(int mapBatchCount) {
    if (mapBatchCount <= 1) return 0;
    var current = mapBatchCount;
    var requests = 0;
    while (current > 1) {
      final next = (current / maximumReduceInputs).ceil();
      requests += next;
      current = next;
    }
    return requests;
  }

  List<List<T>> reductionGroups<T>(List<T> values) {
    final groups = <List<T>>[];
    for (var start = 0; start < values.length; start += maximumReduceInputs) {
      final proposedEnd = start + maximumReduceInputs;
      final end = proposedEnd < values.length ? proposedEnd : values.length;
      groups.add(List<T>.unmodifiable(values.sublist(start, end)));
    }
    return groups;
  }
}

String _clock(int milliseconds) {
  final duration = Duration(milliseconds: milliseconds);
  final hours = duration.inHours;
  final minutes = duration.inMinutes.remainder(60);
  final seconds = duration.inSeconds.remainder(60);
  if (hours > 0) {
    return '${hours.toString().padLeft(2, '0')}:'
        '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }
  return '${minutes.toString().padLeft(2, '0')}:'
      '${seconds.toString().padLeft(2, '0')}';
}
