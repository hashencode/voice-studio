enum AudioNoteStatus { draft, reviewed, rejected, published }

class AudioNoteEntity {
  const AudioNoteEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    this.jobId,
    required this.status,
    required this.providerId,
    required this.modelId,
    required this.processingLocation,
    required this.consentGranted,
    this.consentVersion = 1,
    this.consentAtMs,
    this.payloadSummary,
    required this.inputStartMs,
    required this.inputEndMs,
    this.outputSchemaVersion = 'audio_intelligence_output/v1',
    this.templateId = 'general',
    this.audioType,
    this.suggestedTitle,
    required this.createdAtMs,
    required this.updatedAtMs,
    required this.reviewedAtMs,
    required this.publishedAtMs,
  });

  factory AudioNoteEntity.fromMap(Map<String, Object?> map) {
    return AudioNoteEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      jobId: map['job_id'] as int?,
      status: AudioNoteStatus.values.byName(map['status'] as String),
      providerId: map['provider_id'] as String,
      modelId: map['model_id'] as String,
      processingLocation: map['processing_location'] as String,
      consentGranted: (map['consent_granted'] as int) == 1,
      consentVersion: map['consent_version'] as int? ?? 1,
      consentAtMs: map['consent_at_ms'] as int?,
      payloadSummary: map['payload_summary'] as String?,
      inputStartMs: map['input_start_ms'] as int,
      inputEndMs: map['input_end_ms'] as int,
      outputSchemaVersion:
          map['output_schema_version'] as String? ??
          'audio_intelligence_output/v1',
      templateId: map['template_id'] as String? ?? 'general',
      audioType: map['audio_type'] as String?,
      suggestedTitle: map['suggested_title'] as String?,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
      reviewedAtMs: map['reviewed_at_ms'] as int?,
      publishedAtMs: map['published_at_ms'] as int?,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final int? jobId;
  final AudioNoteStatus status;
  final String providerId;
  final String modelId;
  final String processingLocation;
  final bool consentGranted;
  final int consentVersion;
  final int? consentAtMs;
  final String? payloadSummary;
  final int inputStartMs;
  final int inputEndMs;
  final String outputSchemaVersion;
  final String templateId;
  final String? audioType;
  final String? suggestedTitle;
  final int createdAtMs;
  final int updatedAtMs;
  final int? reviewedAtMs;
  final int? publishedAtMs;
}
