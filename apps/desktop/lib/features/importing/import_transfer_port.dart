class DesktopImportTransferRequest {
  const DesktopImportTransferRequest({
    required this.sourcePath,
    required this.destinationRoot,
    required this.destinationId,
    required this.displayName,
    required this.maxSourceBytes,
    required this.minimumFreeBytes,
    required this.temporaryStorageMultiplier,
    required this.maxDurationMs,
  });

  final String sourcePath;
  final String destinationRoot;
  final String destinationId;
  final String displayName;
  final int maxSourceBytes;
  final int minimumFreeBytes;
  final double temporaryStorageMultiplier;
  final int maxDurationMs;

  Map<String, Object?> toMap() => <String, Object?>{
    'sourcePath': sourcePath,
    'destinationRoot': destinationRoot,
    'destinationId': destinationId,
    'displayName': displayName,
    'maxSourceBytes': maxSourceBytes,
    'minimumFreeBytes': minimumFreeBytes,
    'temporaryStorageMultiplier': temporaryStorageMultiplier,
    'maxDurationMs': maxDurationMs,
  };
}

class DesktopImportTransferResult {
  const DesktopImportTransferResult({
    required this.path,
    required this.sizeBytes,
    required this.fingerprintSha256,
    required this.mediaType,
    required this.durationMs,
  });

  factory DesktopImportTransferResult.fromMap(Map<Object?, Object?> map) {
    final result = DesktopImportTransferResult(
      path: map['path'] as String? ?? '',
      sizeBytes: (map['sizeBytes'] as num?)?.toInt() ?? -1,
      fingerprintSha256: map['fingerprintSha256'] as String? ?? '',
      mediaType: map['mediaType'] as String? ?? '',
      durationMs: (map['durationMs'] as num?)?.toInt() ?? 0,
    );
    if (!result.isValid) {
      throw const DesktopImportFailure(
        'IMPORT_NATIVE_RESULT_INVALID',
        '本地导入宿主返回了不完整结果',
      );
    }
    return result;
  }

  final String path;
  final int sizeBytes;
  final String fingerprintSha256;
  final String mediaType;
  final int durationMs;

  bool get isValid =>
      path.isNotEmpty &&
      sizeBytes > 0 &&
      durationMs > 0 &&
      RegExp(r'^[a-f0-9]{64}$').hasMatch(fingerprintSha256) &&
      const <String>{'audio', 'video'}.contains(mediaType);
}

class DesktopImportFailure implements Exception {
  const DesktopImportFailure(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'DesktopImportFailure($code): $message';
}

abstract interface class DesktopImportTransferPort {
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  );

  Future<void> cancel();

  Future<void> discard(String committedPath);
}
