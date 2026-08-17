enum AudioInsightKind {
  title,
  summary,
  summaryKeyPoint,
  summaryDetailed,
  topic,
  decision,
  action,
  risk,
  unresolved;

  static AudioInsightKind fromStorage(Object? value) {
    return AudioInsightKind.values.firstWhere(
      (kind) => kind.name == value,
      orElse: () => AudioInsightKind.unresolved,
    );
  }
}

enum AudioInsightStatus { draft, reviewed, rejected, published }

enum AudioInsightResolutionState {
  notApplicable,
  open,
  resolved;

  static AudioInsightResolutionState fromStorage(Object? value) {
    return AudioInsightResolutionState.values.firstWhere(
      (state) => state.name == value,
      orElse: () => AudioInsightResolutionState.notApplicable,
    );
  }
}

class AudioInsightEntity {
  const AudioInsightEntity({
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
    this.resolutionState = AudioInsightResolutionState.notApplicable,
    this.topicStartMs,
    this.topicEndMs,
    this.sortOrder = 0,
    required this.createdAtMs,
    required this.updatedAtMs,
    required this.reviewedAtMs,
    required this.rejectedAtMs,
    required this.publishedAtMs,
  });

  factory AudioInsightEntity.fromMap(Map<String, Object?> map) {
    return AudioInsightEntity(
      id: map['id'] as int,
      noteId: map['note_id'] as int,
      kind: AudioInsightKind.fromStorage(map['kind']),
      body: map['body'] as String,
      actionOwner: map['action_owner'] as String?,
      actionDueAtMs: map['action_due_at_ms'] as int?,
      unresolvedOwner: (map['unresolved_owner'] as int? ?? 0) == 1,
      unresolvedDueDate: (map['unresolved_due_date'] as int? ?? 0) == 1,
      status: AudioInsightStatus.values.byName(map['status'] as String),
      unsupported: (map['unsupported'] as int? ?? 0) == 1,
      resolutionState: AudioInsightResolutionState.fromStorage(
        map['resolution_state'],
      ),
      topicStartMs: map['topic_start_ms'] as int?,
      topicEndMs: map['topic_end_ms'] as int?,
      sortOrder: map['sort_order'] as int? ?? 0,
      createdAtMs: map['created_at_ms'] as int,
      updatedAtMs: map['updated_at_ms'] as int,
      reviewedAtMs: map['reviewed_at_ms'] as int?,
      rejectedAtMs: map['rejected_at_ms'] as int?,
      publishedAtMs: map['published_at_ms'] as int?,
    );
  }

  final int id;
  final int noteId;
  final AudioInsightKind kind;
  final String body;
  final String? actionOwner;
  final int? actionDueAtMs;
  final bool unresolvedOwner;
  final bool unresolvedDueDate;
  final AudioInsightStatus status;
  final bool unsupported;
  final AudioInsightResolutionState resolutionState;
  final int? topicStartMs;
  final int? topicEndMs;
  final int sortOrder;
  final int createdAtMs;
  final int updatedAtMs;
  final int? reviewedAtMs;
  final int? rejectedAtMs;
  final int? publishedAtMs;
}
