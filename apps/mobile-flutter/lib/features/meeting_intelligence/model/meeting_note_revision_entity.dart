class MeetingNoteRevisionEntity {
  const MeetingNoteRevisionEntity({
    required this.id,
    required this.noteId,
    required this.insightId,
    required this.previousBody,
    required this.nextBody,
    required this.action,
    required this.createdAtMs,
  });

  factory MeetingNoteRevisionEntity.fromMap(Map<String, Object?> map) {
    return MeetingNoteRevisionEntity(
      id: map['id'] as int,
      noteId: map['note_id'] as int,
      insightId: map['insight_id'] as int?,
      previousBody: map['previous_body'] as String,
      nextBody: map['next_body'] as String,
      action: map['action'] as String,
      createdAtMs: map['created_at_ms'] as int,
    );
  }

  final int id;
  final int noteId;
  final int? insightId;
  final String previousBody;
  final String nextBody;
  final String action;
  final int createdAtMs;
}
