import '../service/meeting_intelligence_provider.dart';

enum MeetingIntelligenceJobStatus {
  queued,
  processing,
  completed,
  failed,
  canceled,
  recoveryUnknown;

  static MeetingIntelligenceJobStatus fromStorage(Object? value) {
    return MeetingIntelligenceJobStatus.values.firstWhere(
      (status) => status.name == value,
      orElse: () => MeetingIntelligenceJobStatus.failed,
    );
  }
}

class MeetingIntelligenceJobEntity {
  const MeetingIntelligenceJobEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.providerId,
    required this.modelId,
    required this.processingLocation,
    required this.templateId,
    required this.status,
    required this.progress,
    required this.attemptCount,
    required this.cancelRequested,
    required this.errorCode,
    required this.dedupeKey,
    required this.inputStartMs,
    required this.inputEndMs,
    required this.segmentCount,
    required this.estimatedRequestCount,
    required this.speakerLabelsIncluded,
    required this.consentVersion,
    required this.consentAtMs,
    required this.payloadSummary,
    required this.startedAtMs,
    required this.completedAtMs,
    required this.heartbeatAtMs,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  factory MeetingIntelligenceJobEntity.fromMap(Map<String, Object?> map) {
    return MeetingIntelligenceJobEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      providerId: map['provider_id'] as String,
      modelId: map['model_id'] as String,
      processingLocation: MeetingProcessingLocation.fromStorage(
        map['processing_location'],
      ),
      templateId: map['template_id'] as String? ?? 'general',
      status: MeetingIntelligenceJobStatus.fromStorage(map['status']),
      progress: (map['progress'] as num? ?? 0).toDouble(),
      attemptCount: map['attempt_count'] as int? ?? 0,
      cancelRequested: (map['cancel_requested'] as int? ?? 0) == 1,
      errorCode: map['error_code'] as String?,
      dedupeKey: map['dedupe_key'] as String,
      inputStartMs: map['input_start_ms'] as int,
      inputEndMs: map['input_end_ms'] as int,
      segmentCount: map['segment_count'] as int? ?? 0,
      estimatedRequestCount: map['estimated_request_count'] as int? ?? 1,
      speakerLabelsIncluded: (map['speaker_labels_included'] as int? ?? 0) == 1,
      consentVersion: map['consent_version'] as int? ?? 1,
      consentAtMs: map['consent_at_ms'] as int?,
      payloadSummary: map['payload_summary'] as String?,
      startedAtMs: map['started_at_ms'] as int?,
      completedAtMs: map['completed_at_ms'] as int?,
      heartbeatAtMs: map['heartbeat_at_ms'] as int?,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final String providerId;
  final String modelId;
  final MeetingProcessingLocation processingLocation;
  final String templateId;
  final MeetingIntelligenceJobStatus status;
  final double progress;
  final int attemptCount;
  final bool cancelRequested;
  final String? errorCode;
  final String dedupeKey;
  final int inputStartMs;
  final int inputEndMs;
  final int segmentCount;
  final int estimatedRequestCount;
  final bool speakerLabelsIncluded;
  final int consentVersion;
  final int? consentAtMs;
  final String? payloadSummary;
  final int? startedAtMs;
  final int? completedAtMs;
  final int? heartbeatAtMs;
  final int createdAtMs;
  final int updatedAtMs;
}
