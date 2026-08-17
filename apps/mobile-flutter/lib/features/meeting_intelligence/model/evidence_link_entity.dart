class EvidenceLinkEntity {
  const EvidenceLinkEntity({
    required this.id,
    required this.insightId,
    required this.segmentId,
    required this.startMs,
    required this.endMs,
    required this.createdAtMs,
  });

  factory EvidenceLinkEntity.fromMap(Map<String, Object?> map) {
    return EvidenceLinkEntity(
      id: map['id'] as int,
      insightId: map['insight_id'] as int,
      segmentId: map['segment_id'] as int,
      startMs: map['start_ms'] as int,
      endMs: map['end_ms'] as int,
      createdAtMs: map['created_at_ms'] as int,
    );
  }

  final int id;
  final int insightId;
  final int segmentId;
  final int startMs;
  final int endMs;
  final int createdAtMs;
}
