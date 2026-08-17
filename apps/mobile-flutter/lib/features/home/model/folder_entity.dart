class FolderEntity {
  FolderEntity({
    required this.name,
    required this.createdAtMs,
    required this.isFavorite,
  });

  final String name;
  final int createdAtMs;
  final bool isFavorite;

  factory FolderEntity.fromMap(Map<String, Object?> map) {
    return FolderEntity(
      name: map['name'] as String,
      createdAtMs: map['created_at_ms'] as int,
      isFavorite: (map['is_favorite'] as int? ?? 0) == 1,
    );
  }
}
