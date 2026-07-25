class TranscriptRevisionEntity {
  const TranscriptRevisionEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.segmentId,
    required this.previousText,
    required this.nextText,
    required this.createdAtMs,
    required this.revertedAtMs,
    this.invalidatedAtMs,
  });

  factory TranscriptRevisionEntity.fromMap(Map<String, Object?> map) {
    return TranscriptRevisionEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      segmentId: map['segment_id'] as int,
      previousText: map['previous_text'] as String,
      nextText: map['next_text'] as String,
      createdAtMs: map['created_at_ms'] as int,
      revertedAtMs: map['reverted_at_ms'] as int?,
      invalidatedAtMs: map['invalidated_at_ms'] as int?,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final int segmentId;
  final String previousText;
  final String nextText;
  final int createdAtMs;
  final int? revertedAtMs;
  final int? invalidatedAtMs;
}
