class TranscriptionJobEntity {
  TranscriptionJobEntity({
    required this.id,
    required this.recordingPath,
    required this.recordingId,
    required this.generationId,
    required this.durationMs,
    required this.status,
    required this.recordingMode,
    required this.source,
    required this.failureStage,
    required this.stage,
    required this.progress,
    required this.attemptCount,
    required this.cancelRequested,
    required this.errorCode,
    required this.startedAtMs,
    required this.completedAtMs,
    required this.heartbeatAtMs,
    required this.createdAtMs,
    required this.updatedAtMs,
    required this.resultText,
    required this.errorMessage,
  });

  final int id;
  final String recordingPath;
  final int? recordingId;
  final int? generationId;
  final int durationMs;
  final String status;
  final String recordingMode;
  final String source;
  final String? failureStage;
  final String stage;
  final double? progress;
  final int attemptCount;
  final bool cancelRequested;
  final String? errorCode;
  final int? startedAtMs;
  final int? completedAtMs;
  final int? heartbeatAtMs;
  final int createdAtMs;
  final int updatedAtMs;
  final String? resultText;
  final String? errorMessage;

  factory TranscriptionJobEntity.fromMap(Map<String, Object?> map) {
    return TranscriptionJobEntity(
      id: map['id'] as int,
      recordingPath: map['recording_path'] as String,
      recordingId: map['recording_id'] as int?,
      generationId: map['generation_id'] as int?,
      durationMs: map['duration_ms'] as int,
      status: map['status'] as String,
      recordingMode: map['recording_mode'] as String? ?? 'standard',
      source: map['source'] as String? ?? 'standard_offline',
      failureStage: map['failure_stage'] as String?,
      stage: map['stage'] as String? ?? 'queued',
      progress: (map['progress'] as num?)?.toDouble(),
      attemptCount: map['attempt_count'] as int? ?? 0,
      cancelRequested: (map['cancel_requested'] as int? ?? 0) == 1,
      errorCode: map['error_code'] as String?,
      startedAtMs: map['started_at_ms'] as int?,
      completedAtMs: map['completed_at_ms'] as int?,
      heartbeatAtMs: map['heartbeat_at_ms'] as int?,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
      resultText: map['result_text'] as String?,
      errorMessage: map['error_message'] as String?,
    );
  }
}
