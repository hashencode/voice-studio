class TranscriptSegmentEntity {
  TranscriptSegmentEntity({
    required this.id,
    required this.recordingPath,
    required this.jobId,
    required this.sequenceId,
    required this.text,
    required this.startMs,
    required this.endMs,
    required this.isFinal,
    required this.source,
    required this.confidence,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  final int id;
  final String recordingPath;
  final int? jobId;
  final int sequenceId;
  final String text;
  final int startMs;
  final int endMs;
  final bool isFinal;
  final String source;
  final double? confidence;
  final int createdAtMs;
  final int updatedAtMs;

  factory TranscriptSegmentEntity.fromMap(Map<String, Object?> map) {
    return TranscriptSegmentEntity(
      id: map['id'] as int,
      recordingPath: map['recording_path'] as String,
      jobId: map['job_id'] as int?,
      sequenceId: map['sequence_id'] as int,
      text: map['text'] as String,
      startMs: map['start_ms'] as int,
      endMs: map['end_ms'] as int,
      isFinal: (map['is_final'] as int? ?? 1) == 1,
      source: map['source'] as String? ?? 'realtime',
      confidence: (map['confidence'] as num?)?.toDouble(),
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }
}
