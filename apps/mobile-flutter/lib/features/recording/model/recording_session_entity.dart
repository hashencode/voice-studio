class RecordingSessionEntity {
  const RecordingSessionEntity({
    required this.sessionId,
    required this.state,
    required this.durationMs,
    required this.createdAtMs,
    required this.updatedAtMs,
    this.stagingPath,
    this.canonicalPath,
    this.stopReason,
    this.errorCategory,
    this.nativeCreatedAtMs,
    this.nativeUpdatedAtMs,
    this.recordingId,
  });

  factory RecordingSessionEntity.fromMap(Map<String, Object?> row) {
    return RecordingSessionEntity(
      sessionId: row['session_id'] as String,
      state: row['state'] as String,
      stagingPath: row['staging_path'] as String?,
      canonicalPath: row['canonical_path'] as String?,
      durationMs: row['duration_ms'] as int? ?? 0,
      stopReason: row['stop_reason'] as String?,
      errorCategory: row['error_category'] as String?,
      nativeCreatedAtMs: row['native_created_at_ms'] as int?,
      nativeUpdatedAtMs: row['native_updated_at_ms'] as int?,
      recordingId: row['recording_id'] as int?,
      createdAtMs: row['created_at_ms'] as int,
      updatedAtMs: row['updated_at_ms'] as int,
    );
  }

  final String sessionId;
  final String state;
  final String? stagingPath;
  final String? canonicalPath;
  final int durationMs;
  final String? stopReason;
  final String? errorCategory;
  final int? nativeCreatedAtMs;
  final int? nativeUpdatedAtMs;
  final int? recordingId;
  final int createdAtMs;
  final int updatedAtMs;
}
