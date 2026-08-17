enum RecordingAnnotationKind {
  marker('marker'),
  note('note');

  const RecordingAnnotationKind(this.storageValue);

  final String storageValue;

  static RecordingAnnotationKind fromStorageValue(String value) {
    return switch (value) {
      'marker' => RecordingAnnotationKind.marker,
      'note' => RecordingAnnotationKind.note,
      _ => throw StateError('未知录音注释类型: $value'),
    };
  }
}

class RecordingAnnotationEntity {
  const RecordingAnnotationEntity({
    required this.id,
    required this.sessionId,
    required this.kind,
    required this.positionMs,
    required this.createdAtMs,
    required this.updatedAtMs,
    this.text,
  });

  factory RecordingAnnotationEntity.fromMap(Map<String, Object?> row) {
    return RecordingAnnotationEntity(
      id: row['id'] as int,
      sessionId: row['session_id'] as String,
      kind: RecordingAnnotationKind.fromStorageValue(row['kind'] as String),
      positionMs: row['position_ms'] as int,
      text: row['text'] as String?,
      createdAtMs: row['created_at_ms'] as int,
      updatedAtMs: row['updated_at_ms'] as int,
    );
  }

  final int id;
  final String sessionId;
  final RecordingAnnotationKind kind;
  final int positionMs;
  final String? text;
  final int createdAtMs;
  final int updatedAtMs;
}
