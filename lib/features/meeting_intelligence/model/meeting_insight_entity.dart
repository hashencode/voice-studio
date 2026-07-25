enum MeetingInsightKind { summary, decision, action, risk }

enum MeetingInsightStatus { draft, reviewed, rejected, published }

class MeetingInsightEntity {
  const MeetingInsightEntity({
    required this.id,
    required this.noteId,
    required this.kind,
    required this.body,
    required this.actionOwner,
    required this.actionDueAtMs,
    required this.unresolvedOwner,
    required this.unresolvedDueDate,
    required this.status,
    required this.unsupported,
    required this.createdAtMs,
    required this.updatedAtMs,
    required this.reviewedAtMs,
    required this.rejectedAtMs,
    required this.publishedAtMs,
  });

  factory MeetingInsightEntity.fromMap(Map<String, Object?> map) {
    return MeetingInsightEntity(
      id: map['id'] as int,
      noteId: map['note_id'] as int,
      kind: MeetingInsightKind.values.byName(map['kind'] as String),
      body: map['body'] as String,
      actionOwner: map['action_owner'] as String?,
      actionDueAtMs: map['action_due_at_ms'] as int?,
      unresolvedOwner: (map['unresolved_owner'] as int? ?? 0) == 1,
      unresolvedDueDate: (map['unresolved_due_date'] as int? ?? 0) == 1,
      status: MeetingInsightStatus.values.byName(map['status'] as String),
      unsupported: (map['unsupported'] as int? ?? 0) == 1,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
      reviewedAtMs: map['reviewed_at_ms'] as int?,
      rejectedAtMs: map['rejected_at_ms'] as int?,
      publishedAtMs: map['published_at_ms'] as int?,
    );
  }

  final int id;
  final int noteId;
  final MeetingInsightKind kind;
  final String body;
  final String? actionOwner;
  final int? actionDueAtMs;
  final bool unresolvedOwner;
  final bool unresolvedDueDate;
  final MeetingInsightStatus status;
  final bool unsupported;
  final int createdAtMs;
  final int updatedAtMs;
  final int? reviewedAtMs;
  final int? rejectedAtMs;
  final int? publishedAtMs;
}
