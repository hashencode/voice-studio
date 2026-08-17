enum SpeakerAssignmentState {
  assigned,
  overlap,
  unknown;

  static SpeakerAssignmentState fromStorage(Object? value) {
    return SpeakerAssignmentState.values.firstWhere(
      (state) => state.name == value,
      orElse: () => SpeakerAssignmentState.unknown,
    );
  }
}

class SpeakerTurnEntity {
  const SpeakerTurnEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.speakerId,
    required this.startMs,
    required this.endMs,
    required this.source,
    required this.confidence,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  factory SpeakerTurnEntity.fromMap(Map<String, Object?> map) {
    return SpeakerTurnEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      speakerId: map['speaker_id'] as int,
      startMs: map['start_ms'] as int,
      endMs: map['end_ms'] as int,
      source: map['source'] as String? ?? 'automatic',
      confidence: (map['confidence'] as num?)?.toDouble(),
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final int speakerId;
  final int startMs;
  final int endMs;
  final String source;
  final double? confidence;
  final int createdAtMs;
  final int updatedAtMs;
}

class TranscriptSpeakerAssignmentEntity {
  const TranscriptSpeakerAssignmentEntity({
    required this.id,
    required this.recordingId,
    required this.generationId,
    required this.segmentId,
    required this.speakerId,
    required this.startMs,
    required this.endMs,
    required this.state,
    required this.source,
    required this.createdAtMs,
    required this.updatedAtMs,
  });

  factory TranscriptSpeakerAssignmentEntity.fromMap(Map<String, Object?> map) {
    return TranscriptSpeakerAssignmentEntity(
      id: map['id'] as int,
      recordingId: map['recording_id'] as int,
      generationId: map['generation_id'] as int,
      segmentId: map['segment_id'] as int,
      speakerId: map['speaker_id'] as int?,
      startMs: map['start_ms'] as int,
      endMs: map['end_ms'] as int,
      state: SpeakerAssignmentState.fromStorage(map['state']),
      source: map['source'] as String? ?? 'automatic',
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
    );
  }

  final int id;
  final int recordingId;
  final int generationId;
  final int segmentId;
  final int? speakerId;
  final int startMs;
  final int endMs;
  final SpeakerAssignmentState state;
  final String source;
  final int createdAtMs;
  final int updatedAtMs;
}
