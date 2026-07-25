class ImportCandidate {
  const ImportCandidate({
    required this.path,
    required this.displayName,
    required this.sizeBytes,
    required this.durationMs,
    required this.fingerprintSha256,
    required this.duplicateAsset,
    this.mimeType,
  });

  factory ImportCandidate.fromMap(Map<Object?, Object?> map) {
    return ImportCandidate(
      path: map['path'] as String? ?? '',
      displayName: map['displayName'] as String? ?? '导入媒体',
      mimeType: map['mimeType'] as String?,
      sizeBytes: (map['sizeBytes'] as num?)?.toInt() ?? 0,
      durationMs: (map['durationMs'] as num?)?.toInt() ?? 0,
      fingerprintSha256: map['fingerprintSha256'] as String? ?? '',
      duplicateAsset: map['duplicateAsset'] as bool? ?? false,
    );
  }

  final String path;
  final String displayName;
  final String? mimeType;
  final int sizeBytes;
  final int durationMs;
  final String fingerprintSha256;
  final bool duplicateAsset;
}
