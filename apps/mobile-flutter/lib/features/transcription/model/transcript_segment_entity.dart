enum TranscriptReviewState {
  unreviewed('unreviewed'),
  needsReview('needs_review'),
  reviewed('reviewed');

  const TranscriptReviewState(this.storageValue);

  final String storageValue;

  static TranscriptReviewState fromStorage(Object? value) {
    return TranscriptReviewState.values.firstWhere(
      (state) => state.storageValue == value,
      orElse: () => TranscriptReviewState.unreviewed,
    );
  }
}

class TranscriptSegmentEntity {
  TranscriptSegmentEntity({
    required this.id,
    required this.recordingPath,
    required this.recordingId,
    required this.generationId,
    required this.jobId,
    required this.sequenceId,
    required this.text,
    required this.startMs,
    required this.endMs,
    required this.isFinal,
    required this.source,
    required this.confidence,
    this.reviewState = TranscriptReviewState.unreviewed,
    this.reviewedAtMs,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  final int id;
  final String recordingPath;
  final int? recordingId;
  final int generationId;
  final int? jobId;
  final int sequenceId;
  final String text;
  final int startMs;
  final int endMs;
  final bool isFinal;
  final String source;
  final double? confidence;
  final TranscriptReviewState reviewState;
  final int? reviewedAtMs;
  final int createdAtMs;
  final int updatedAtMs;

  factory TranscriptSegmentEntity.fromMap(Map<String, Object?> map) {
    return TranscriptSegmentEntity(
      id: map['id'] as int,
      recordingPath: map['recording_path'] as String,
      recordingId: map['recording_id'] as int?,
      generationId: map['generation_id'] as int? ?? 0,
      jobId: map['job_id'] as int?,
      sequenceId: map['sequence_id'] as int,
      text: map['text'] as String,
      startMs: map['start_ms'] as int,
      endMs: map['end_ms'] as int,
      isFinal: (map['is_final'] as int? ?? 1) == 1,
      source: map['source'] as String? ?? 'realtime',
      confidence: (map['confidence'] as num?)?.toDouble(),
      reviewState: TranscriptReviewState.fromStorage(map['review_state']),
      reviewedAtMs: map['reviewed_at_ms'] as int?,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  TranscriptSegmentEntity copyWith({
    String? text,
    TranscriptReviewState? reviewState,
    int? reviewedAtMs,
    bool clearReviewedAtMs = false,
    int? updatedAtMs,
  }) {
    return TranscriptSegmentEntity(
      id: id,
      recordingPath: recordingPath,
      recordingId: recordingId,
      generationId: generationId,
      jobId: jobId,
      sequenceId: sequenceId,
      text: text ?? this.text,
      startMs: startMs,
      endMs: endMs,
      isFinal: isFinal,
      source: source,
      confidence: confidence,
      reviewState: reviewState ?? this.reviewState,
      reviewedAtMs: clearReviewedAtMs
          ? null
          : reviewedAtMs ?? this.reviewedAtMs,
      createdAtMs: createdAtMs,
      updatedAtMs: updatedAtMs ?? this.updatedAtMs,
    );
  }
}
