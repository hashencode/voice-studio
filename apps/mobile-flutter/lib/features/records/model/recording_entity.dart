class RecordingEntity {
  RecordingEntity({
    required this.id,
    required this.filePath,
    required this.displayName,
    required this.groupName,
    required this.deletedAtMs,
    required this.isFavorite,
    required this.durationMs,
    required this.createdAtMs,
    this.assetKind = 'recording',
    this.fingerprintSha256,
    this.sourceDisplayName,
    this.deletionState = 'active',
    this.activeGenerationId,
  });

  final int id;
  final String filePath;
  final String? displayName;
  final String? groupName;
  final int? deletedAtMs;
  final bool isFavorite;
  final int durationMs;
  final int createdAtMs;
  final String assetKind;
  final String? fingerprintSha256;
  final String? sourceDisplayName;
  final String deletionState;
  final int? activeGenerationId;

  factory RecordingEntity.fromMap(Map<String, Object?> map) {
    return RecordingEntity(
      id: map['id'] as int,
      filePath: map['file_path'] as String,
      displayName: map['display_name'] as String?,
      groupName: map['group_name'] as String?,
      deletedAtMs: map['deleted_at_ms'] as int?,
      isFavorite: (map['is_favorite'] as int? ?? 0) == 1,
      durationMs: map['duration_ms'] as int,
      createdAtMs: map['created_at_ms'] as int,
      assetKind: map['asset_kind'] as String? ?? 'recording',
      fingerprintSha256: map['fingerprint_sha256'] as String?,
      sourceDisplayName: map['source_display_name'] as String?,
      deletionState: map['deletion_state'] as String? ?? 'active',
      activeGenerationId: map['active_generation_id'] as int?,
    );
  }
}
