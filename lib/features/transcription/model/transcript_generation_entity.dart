class TranscriptGenerationEntity {
  const TranscriptGenerationEntity({
    required this.id,
    required this.recordingId,
    required this.recordingPath,
    required this.jobId,
    required this.status,
    required this.source,
    required this.mergedText,
    required this.hasUserEdits,
    required this.hasEvidenceLinks,
    required this.createdAtMs,
    required this.activatedAtMs,
    required this.updatedAtMs,
  });

  factory TranscriptGenerationEntity.fromMap(Map<String, Object?> map) {
    return TranscriptGenerationEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int?,
      recordingPath: map['recording_path'] as String,
      jobId: map['job_id'] as int?,
      status: map['status'] as String,
      source: map['source'] as String,
      mergedText: map['merged_text'] as String,
      hasUserEdits: (map['has_user_edits'] as int? ?? 0) == 1,
      hasEvidenceLinks: (map['has_evidence_links'] as int? ?? 0) == 1,
      createdAtMs: map['created_at_ms'] as int,
      activatedAtMs: map['activated_at_ms'] as int?,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  final int id;
  final int? recordingId;
  final String recordingPath;
  final int? jobId;
  final String status;
  final String source;
  final String mergedText;
  final bool hasUserEdits;
  final bool hasEvidenceLinks;
  final int createdAtMs;
  final int? activatedAtMs;
  final int updatedAtMs;
}
