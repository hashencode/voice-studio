enum MeetingNoteStatus { draft, reviewed, rejected, published }

class MeetingNoteEntity {
  const MeetingNoteEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.status,
    required this.providerId,
    required this.modelId,
    required this.processingLocation,
    required this.consentGranted,
    required this.inputStartMs,
    required this.inputEndMs,
    required this.createdAtMs,
    required this.updatedAtMs,
    required this.reviewedAtMs,
    required this.publishedAtMs,
  });

  factory MeetingNoteEntity.fromMap(Map<String, Object?> map) {
    return MeetingNoteEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      status: MeetingNoteStatus.values.byName(map['status'] as String),
      providerId: map['provider_id'] as String,
      modelId: map['model_id'] as String,
      processingLocation: map['processing_location'] as String,
      consentGranted: (map['consent_granted'] as int) == 1,
      inputStartMs: map['input_start_ms'] as int,
      inputEndMs: map['input_end_ms'] as int,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
      reviewedAtMs: map['reviewed_at_ms'] as int?,
      publishedAtMs: map['published_at_ms'] as int?,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final MeetingNoteStatus status;
  final String providerId;
  final String modelId;
  final String processingLocation;
  final bool consentGranted;
  final int inputStartMs;
  final int inputEndMs;
  final int createdAtMs;
  final int updatedAtMs;
  final int? reviewedAtMs;
  final int? publishedAtMs;
}
