import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  const hash =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  test('model registry binds version, target, hash, license and cache key', () {
    final manifest = ModelAssetManifest.fromJson(<String, Object?>{
      'schemaVersion': 1,
      'assetId': 'sherpa-paraformer-zh',
      'assetVersion': '2026.07.1',
      'platform': 'macos',
      'architecture': 'arm64',
      'sha256': hash,
      'bytes': 4096,
      'licenseId': 'Apache-2.0',
      'licensePath': 'licenses/sherpa-paraformer-zh.txt',
      'cacheKey': '$hash-macos-arm64',
      'installStatus': 'not_installed',
    });

    expect(manifest.installStatus, ModelAssetInstallStatus.notInstalled);
    expect(manifest.toJson()['cacheKey'], '$hash-macos-arm64');
  });

  test('model registry rejects traversal and mismatched cache identity', () {
    expect(
      () => ModelAssetManifest.fromJson(<String, Object?>{
        'schemaVersion': 1,
        'assetId': 'sherpa-paraformer-zh',
        'assetVersion': '2026.07.1',
        'platform': 'macos',
        'architecture': 'arm64',
        'sha256': hash,
        'bytes': 4096,
        'licenseId': 'Apache-2.0',
        'licensePath': '../secret',
        'cacheKey': 'mutable-name',
        'installStatus': 'installed',
      }),
      throwsFormatException,
    );
  });
}
