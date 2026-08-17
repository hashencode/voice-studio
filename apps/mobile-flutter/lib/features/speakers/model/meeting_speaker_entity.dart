class MeetingSpeakerEntity {
  const MeetingSpeakerEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.stableKey,
    required this.displayName,
    required this.source,
    required this.mergedIntoSpeakerId,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  factory MeetingSpeakerEntity.fromMap(Map<String, Object?> map) {
    return MeetingSpeakerEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      stableKey: map['stable_key'] as String,
      displayName: map['display_name'] as String,
      source: map['source'] as String? ?? 'automatic',
      mergedIntoSpeakerId: map['merged_into_speaker_id'] as int?,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final String stableKey;
  final String displayName;
  final String source;
  final int? mergedIntoSpeakerId;
  final int createdAtMs;
  final int updatedAtMs;
}
