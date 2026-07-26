enum ModelAssetInstallStatus {
  notInstalled,
  installing,
  installed,
  corrupt,
  blocked;

  static ModelAssetInstallStatus parse(String value) => switch (value) {
    'not_installed' => notInstalled,
    'installing' => installing,
    'installed' => installed,
    'corrupt' => corrupt,
    'blocked' => blocked,
    _ => throw FormatException('Unknown model asset install status: $value'),
  };

  String get wireValue => switch (this) {
    notInstalled => 'not_installed',
    installing => 'installing',
    installed => 'installed',
    corrupt => 'corrupt',
    blocked => 'blocked',
  };
}

class ModelAssetManifest {
  const ModelAssetManifest({
    required this.schemaVersion,
    required this.assetId,
    required this.assetVersion,
    required this.platform,
    required this.architecture,
    required this.sha256,
    required this.bytes,
    required this.licenseId,
    required this.licensePath,
    required this.cacheKey,
    required this.installStatus,
  });

  factory ModelAssetManifest.fromJson(Map<String, Object?> json) {
    final manifest = ModelAssetManifest(
      schemaVersion: json['schemaVersion'] as int? ?? 0,
      assetId: json['assetId'] as String? ?? '',
      assetVersion: json['assetVersion'] as String? ?? '',
      platform: json['platform'] as String? ?? '',
      architecture: json['architecture'] as String? ?? '',
      sha256: json['sha256'] as String? ?? '',
      bytes: json['bytes'] as int? ?? -1,
      licenseId: json['licenseId'] as String? ?? '',
      licensePath: json['licensePath'] as String? ?? '',
      cacheKey: json['cacheKey'] as String? ?? '',
      installStatus: ModelAssetInstallStatus.parse(
        json['installStatus'] as String? ?? '',
      ),
    );
    manifest.validate();
    return manifest;
  }

  final int schemaVersion;
  final String assetId;
  final String assetVersion;
  final String platform;
  final String architecture;
  final String sha256;
  final int bytes;
  final String licenseId;
  final String licensePath;
  final String cacheKey;
  final ModelAssetInstallStatus installStatus;

  void validate() {
    if (schemaVersion != 1) {
      throw const FormatException('Unsupported model asset manifest schema');
    }
    if (!_identifier.hasMatch(assetId) ||
        assetVersion.trim().isEmpty ||
        !_platforms.contains(platform) ||
        !_architectures.contains(architecture) ||
        !_sha256.hasMatch(sha256) ||
        bytes <= 0 ||
        licenseId.trim().isEmpty ||
        licensePath.trim().isEmpty ||
        pIsUnsafe(licensePath) ||
        cacheKey != '$sha256-$platform-$architecture') {
      throw const FormatException('Invalid model asset manifest');
    }
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': schemaVersion,
    'assetId': assetId,
    'assetVersion': assetVersion,
    'platform': platform,
    'architecture': architecture,
    'sha256': sha256,
    'bytes': bytes,
    'licenseId': licenseId,
    'licensePath': licensePath,
    'cacheKey': cacheKey,
    'installStatus': installStatus.wireValue,
  };

  static bool pIsUnsafe(String value) {
    final normalized = value.replaceAll(r'\', '/');
    return normalized.startsWith('/') ||
        normalized.split('/').contains('..') ||
        normalized.contains('\u0000');
  }

  static final RegExp _identifier = RegExp(r'^[a-z0-9][a-z0-9._-]{1,127}$');
  static final RegExp _sha256 = RegExp(r'^[a-f0-9]{64}$');
  static const Set<String> _platforms = <String>{'macos', 'windows'};
  static const Set<String> _architectures = <String>{'arm64', 'x86_64'};
}
