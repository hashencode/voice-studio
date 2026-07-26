import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as path;
import 'package:processing_contracts/processing_contracts.dart';

class SidecarRuntimeArtifact {
  SidecarRuntimeArtifact({
    required this.relativePath,
    required this.source,
    required this.sha256,
    required this.bytes,
  }) {
    SidecarRelativePath.requireSafe(relativePath);
    if (source.scheme != 'https' ||
        !_sha256Pattern.hasMatch(sha256) ||
        bytes <= 0) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_MANIFEST_INVALID',
        'Runtime artifact identity is invalid.',
      );
    }
  }

  final String relativePath;
  final Uri source;
  final String sha256;
  final int bytes;

  factory SidecarRuntimeArtifact.fromJson(Map<String, Object?> json) {
    final relativePath = json['relativePath'];
    final source = json['source'];
    final sha256 = json['sha256'];
    final bytes = json['bytes'];
    if (relativePath is! String ||
        source is! String ||
        sha256 is! String ||
        bytes is! int) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_MANIFEST_INVALID',
        'Runtime artifact fields are invalid.',
      );
    }
    return SidecarRuntimeArtifact(
      relativePath: relativePath,
      source: Uri.parse(source),
      sha256: sha256,
      bytes: bytes,
    );
  }

  Map<String, Object> toJson() => <String, Object>{
    'relativePath': relativePath,
    'source': source.toString(),
    'sha256': sha256,
    'bytes': bytes,
  };
}

class SidecarRuntimeManifest {
  SidecarRuntimeManifest({
    required this.runtimeId,
    required this.runtimeVersion,
    required this.platform,
    required this.architecture,
    required this.contentKey,
    required this.licenseDisposition,
    required this.requiresUserAcceptance,
    required this.userConditionsAccepted,
    required this.minimumFreeBytesAfterInstall,
    required this.artifacts,
  }) {
    if (!_identifierPattern.hasMatch(runtimeId) ||
        !_identifierPattern.hasMatch(runtimeVersion) ||
        !_sha256Pattern.hasMatch(contentKey) ||
        artifacts.isEmpty ||
        minimumFreeBytesAfterInstall < 0) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_MANIFEST_INVALID',
        'Runtime manifest identity or limits are invalid.',
      );
    }
    final paths = artifacts.map((artifact) => artifact.relativePath).toSet();
    if (paths.length != artifacts.length) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_MANIFEST_INVALID',
        'Runtime artifact paths must be unique.',
      );
    }
  }

  final String runtimeId;
  final String runtimeVersion;
  final String platform;
  final String architecture;
  final String contentKey;
  final String licenseDisposition;
  final bool requiresUserAcceptance;
  final bool userConditionsAccepted;
  final int minimumFreeBytesAfterInstall;
  final List<SidecarRuntimeArtifact> artifacts;

  int get totalArtifactBytes =>
      artifacts.fold(0, (total, artifact) => total + artifact.bytes);

  factory SidecarRuntimeManifest.fromJson(Map<String, Object?> json) {
    final rawArtifacts = json['artifacts'];
    if (json['schemaVersion'] != 1 ||
        json['runtimeId'] is! String ||
        json['runtimeVersion'] is! String ||
        json['platform'] is! String ||
        json['architecture'] is! String ||
        json['contentKey'] is! String ||
        json['licenseDisposition'] is! String ||
        json['requiresUserAcceptance'] is! bool ||
        json['userConditionsAccepted'] is! bool ||
        json['minimumFreeBytesAfterInstall'] is! int ||
        rawArtifacts is! List<Object?> ||
        rawArtifacts.any((artifact) => artifact is! Map<String, Object?>)) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_MANIFEST_INVALID',
        'Runtime manifest fields are invalid.',
      );
    }
    return SidecarRuntimeManifest(
      runtimeId: json['runtimeId']! as String,
      runtimeVersion: json['runtimeVersion']! as String,
      platform: json['platform']! as String,
      architecture: json['architecture']! as String,
      contentKey: json['contentKey']! as String,
      licenseDisposition: json['licenseDisposition']! as String,
      requiresUserAcceptance: json['requiresUserAcceptance']! as bool,
      userConditionsAccepted: json['userConditionsAccepted']! as bool,
      minimumFreeBytesAfterInstall:
          json['minimumFreeBytesAfterInstall']! as int,
      artifacts: rawArtifacts
          .cast<Map<String, Object?>>()
          .map(SidecarRuntimeArtifact.fromJson)
          .toList(growable: false),
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': 1,
    'runtimeId': runtimeId,
    'runtimeVersion': runtimeVersion,
    'platform': platform,
    'architecture': architecture,
    'contentKey': contentKey,
    'licenseDisposition': licenseDisposition,
    'requiresUserAcceptance': requiresUserAcceptance,
    'userConditionsAccepted': userConditionsAccepted,
    'minimumFreeBytesAfterInstall': minimumFreeBytesAfterInstall,
    'artifacts': artifacts.map((artifact) => artifact.toJson()).toList(),
  };
}

abstract interface class SidecarArtifactFetcher {
  Future<void> fetch({
    required Uri source,
    required File destination,
    required int resumeFrom,
  });
}

abstract interface class SidecarCapacityProbe {
  Future<int> availableBytes(Directory root);
}

class SidecarRuntimeInstallation {
  const SidecarRuntimeInstallation({
    required this.runtimeRoot,
    required this.contentKey,
    required this.reused,
  });

  final Directory runtimeRoot;
  final String contentKey;
  final bool reused;
}

class SidecarRuntimeManager {
  const SidecarRuntimeManager({
    required this.root,
    required this.platform,
    required this.architecture,
    required this.fetcher,
    required this.capacityProbe,
  });

  final Directory root;
  final String platform;
  final String architecture;
  final SidecarArtifactFetcher fetcher;
  final SidecarCapacityProbe capacityProbe;

  Future<SidecarRuntimeInstallation> provision(
    SidecarRuntimeManifest manifest,
  ) async {
    _requireAdmissible(manifest);
    await root.create(recursive: true);
    final runtimeRoot = _runtimeRoot(manifest.contentKey);
    if (await runtimeRoot.exists()) {
      await _verify(manifest, runtimeRoot);
      await _activate(manifest);
      return SidecarRuntimeInstallation(
        runtimeRoot: runtimeRoot,
        contentKey: manifest.contentKey,
        reused: true,
      );
    }
    final requiredBytes =
        manifest.totalArtifactBytes * 2 + manifest.minimumFreeBytesAfterInstall;
    if (await capacityProbe.availableBytes(root) < requiredBytes) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_INSUFFICIENT_SPACE',
        'Runtime provisioning lacks staging and reserve capacity.',
      );
    }
    final staging = Directory(
      path.join(root.path, 'staging', '${manifest.contentKey}.partial'),
    );
    await staging.create(recursive: true);
    for (final artifact in manifest.artifacts) {
      final destination = File(path.join(staging.path, artifact.relativePath));
      await destination.parent.create(recursive: true);
      var resumeFrom = 0;
      if (await destination.exists()) {
        resumeFrom = await destination.length();
        if (resumeFrom > artifact.bytes) {
          await destination.rename('${destination.path}.oversize');
          resumeFrom = 0;
        }
      }
      if (resumeFrom < artifact.bytes) {
        await fetcher.fetch(
          source: artifact.source,
          destination: destination,
          resumeFrom: resumeFrom,
        );
      }
      await _verifyArtifact(artifact, destination);
    }
    final receipt = File(path.join(staging.path, '.runtime-receipt.json'));
    await receipt.writeAsString(
      '${jsonEncode(manifest.toJson())}\n',
      flush: true,
    );
    await runtimeRoot.parent.create(recursive: true);
    await staging.rename(runtimeRoot.path);
    await _activate(manifest);
    return SidecarRuntimeInstallation(
      runtimeRoot: runtimeRoot,
      contentKey: manifest.contentKey,
      reused: false,
    );
  }

  Future<SidecarRuntimeInstallation> repair(
    SidecarRuntimeManifest manifest,
  ) async {
    final runtime = _runtimeRoot(manifest.contentKey);
    if (await runtime.exists()) {
      try {
        await _verify(manifest, runtime);
        await _activate(manifest);
        return SidecarRuntimeInstallation(
          runtimeRoot: runtime,
          contentKey: manifest.contentKey,
          reused: true,
        );
      } on SidecarProtocolException {
        final quarantine = Directory(
          path.join(
            root.path,
            'quarantine',
            '${manifest.contentKey}-${DateTime.now().microsecondsSinceEpoch}',
          ),
        );
        await quarantine.parent.create(recursive: true);
        await runtime.rename(quarantine.path);
      }
    }
    return provision(manifest);
  }

  Future<void> rollback(String runtimeId) async {
    final pointer = await _readPointer(runtimeId);
    final previous = pointer['previous'];
    final current = pointer['current'];
    if (previous is! String ||
        current is! String ||
        !await _runtimeRoot(previous).exists()) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_ROLLBACK_UNAVAILABLE',
        'No verified previous runtime is available.',
      );
    }
    await _writePointer(runtimeId, current: previous, previous: current);
  }

  Future<void> prune() async {
    final retained = <String>{};
    final active = Directory(path.join(root.path, 'active'));
    if (await active.exists()) {
      await for (final entry in active.list()) {
        if (entry is! File || !entry.path.endsWith('.json')) continue;
        final pointer =
            jsonDecode(await entry.readAsString()) as Map<String, Object?>;
        for (final key in const <String>['current', 'previous']) {
          final value = pointer[key];
          if (value is String) retained.add(value);
        }
      }
    }
    final runtimes = Directory(path.join(root.path, 'runtimes'));
    if (!await runtimes.exists()) return;
    await for (final entry in runtimes.list()) {
      if (entry is Directory && !retained.contains(path.basename(entry.path))) {
        await entry.delete(recursive: true);
      }
    }
  }

  Future<void> uninstall(String runtimeId) async {
    final pointerFile = _pointerFile(runtimeId);
    if (!await pointerFile.exists()) return;
    final pointer = await _readPointer(runtimeId);
    await pointerFile.delete();
    for (final key in const <String>['current', 'previous']) {
      final contentKey = pointer[key];
      if (contentKey is String) {
        final runtime = _runtimeRoot(contentKey);
        if (await runtime.exists()) await runtime.delete(recursive: true);
      }
    }
  }

  void _requireAdmissible(SidecarRuntimeManifest manifest) {
    if (manifest.platform != platform ||
        manifest.architecture != architecture) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_TARGET_MISMATCH',
        'Runtime manifest is for another target.',
      );
    }
    if (manifest.licenseDisposition.startsWith('LAB_ONLY') ||
        manifest.requiresUserAcceptance && !manifest.userConditionsAccepted) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_LICENSE_BLOCKED',
        'Runtime model conditions are not accepted for product use.',
      );
    }
  }

  Future<void> _verify(
    SidecarRuntimeManifest manifest,
    Directory runtime,
  ) async {
    for (final artifact in manifest.artifacts) {
      await _verifyArtifact(
        artifact,
        File(path.join(runtime.path, artifact.relativePath)),
      );
    }
  }

  Future<void> _verifyArtifact(
    SidecarRuntimeArtifact artifact,
    File file,
  ) async {
    if (!await file.exists() || await file.length() != artifact.bytes) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_HASH_MISMATCH',
        'Runtime artifact size does not match the manifest.',
      );
    }
    final digest = (await sha256.bind(file.openRead()).first).toString();
    if (digest != artifact.sha256) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_HASH_MISMATCH',
        'Runtime artifact hash does not match the manifest.',
      );
    }
  }

  Future<void> _activate(SidecarRuntimeManifest manifest) async {
    var previous = <String, Object?>{};
    try {
      previous = await _readPointer(manifest.runtimeId);
    } on FileSystemException {
      // First install has no active pointer.
    }
    await _writePointer(
      manifest.runtimeId,
      current: manifest.contentKey,
      previous: previous['current'] as String?,
    );
  }

  Future<Map<String, Object?>> _readPointer(String runtimeId) async {
    final value = jsonDecode(await _pointerFile(runtimeId).readAsString());
    if (value is! Map<String, Object?>) {
      throw const SidecarProtocolException(
        'SIDECAR_RUNTIME_POINTER_INVALID',
        'Runtime activation pointer is invalid.',
      );
    }
    return value;
  }

  Future<void> _writePointer(
    String runtimeId, {
    required String current,
    String? previous,
  }) async {
    final destination = _pointerFile(runtimeId);
    await destination.parent.create(recursive: true);
    final temporary = File('${destination.path}.partial');
    await temporary.writeAsString(
      '${jsonEncode(<String, Object?>{'schemaVersion': 1, 'runtimeId': runtimeId, 'current': current, 'previous': previous})}\n',
      flush: true,
    );
    await temporary.rename(destination.path);
  }

  Directory _runtimeRoot(String contentKey) =>
      Directory(path.join(root.path, 'runtimes', contentKey));

  File _pointerFile(String runtimeId) =>
      File(path.join(root.path, 'active', '$runtimeId.json'));
}

final RegExp _sha256Pattern = RegExp(r'^[0-9a-f]{64}$');
final RegExp _identifierPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._+-]*$');
