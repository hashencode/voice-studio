import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';

class FrozenSherpaDownload {
  FrozenSherpaDownload({
    required this.id,
    required this.source,
    required this.sha256,
    required this.bytes,
    required this.kind,
  }) {
    if (!_id.hasMatch(id) ||
        source.scheme != 'https' ||
        !_sha.hasMatch(sha256) ||
        bytes <= 0 ||
        !const {'file', 'tar.bz2'}.contains(kind)) {
      throw const FormatException('invalid frozen Sherpa download');
    }
  }

  final String id;
  final Uri source;
  final String sha256;
  final int bytes;
  final String kind;
}

class FrozenSherpaFile {
  FrozenSherpaFile({
    required this.relativePath,
    required this.downloadId,
    required this.sha256,
    required this.bytes,
    required this.licenseSpdx,
    this.archiveMember,
  }) {
    if (ModelAssetManifest.pIsUnsafe(relativePath) ||
        ModelAssetManifest.pIsUnsafe(archiveMember ?? 'safe') ||
        !_id.hasMatch(downloadId) ||
        !_sha.hasMatch(sha256) ||
        bytes <= 0 ||
        licenseSpdx.trim().isEmpty) {
      throw const FormatException('invalid frozen Sherpa file');
    }
  }

  final String relativePath;
  final String downloadId;
  final String? archiveMember;
  final String sha256;
  final int bytes;
  final String licenseSpdx;
}

class FrozenSherpaManifest {
  FrozenSherpaManifest({
    required this.setId,
    required this.platform,
    required this.architecture,
    required this.contentKey,
    required this.licenseDisposition,
    required this.distributionEligible,
    required this.requiresUserAcceptance,
    required this.minimumFreeBytesAfterInstall,
    required this.downloads,
    required this.files,
  }) {
    if (!_id.hasMatch(setId) ||
        !_supportedTargets.contains((platform, architecture)) ||
        !_sha.hasMatch(contentKey) ||
        (distributionEligible
            ? licenseDisposition != 'PRODUCT_ELIGIBLE_WITH_PINNED_NOTICES'
            : licenseDisposition !=
                  'PRODUCT_ELIGIBLE_WITH_PINNED_NOTICES_CONVERTER_LICENSE_REVIEW_REQUIRED') ||
        requiresUserAcceptance ||
        minimumFreeBytesAfterInstall < 0 ||
        downloads.isEmpty ||
        files.isEmpty ||
        downloads.map((item) => item.id).toSet().length != downloads.length ||
        files.map((item) => item.relativePath).toSet().length != files.length) {
      throw const FormatException('invalid frozen Sherpa manifest');
    }
    final ids = downloads.map((item) => item.id).toSet();
    if (files.any((file) => !ids.contains(file.downloadId))) {
      throw const FormatException('frozen Sherpa file references no download');
    }
  }

  factory FrozenSherpaManifest.fromJson(Map<String, Object?> json) {
    if (json['schemaVersion'] != 1 ||
        json['downloads'] is! List<Object?> ||
        json['files'] is! List<Object?>) {
      throw const FormatException('unsupported frozen Sherpa manifest');
    }
    final downloads = (json['downloads']! as List<Object?>)
        .map((value) {
          final item = (value as Map).cast<String, Object?>();
          return FrozenSherpaDownload(
            id: item['id']! as String,
            source: Uri.parse(item['source']! as String),
            sha256: item['sha256']! as String,
            bytes: item['bytes']! as int,
            kind: item['kind']! as String,
          );
        })
        .toList(growable: false);
    final files = (json['files']! as List<Object?>)
        .map((value) {
          final item = (value as Map).cast<String, Object?>();
          return FrozenSherpaFile(
            relativePath: item['relativePath']! as String,
            downloadId: item['downloadId']! as String,
            archiveMember: item['archiveMember'] as String?,
            sha256: item['sha256']! as String,
            bytes: item['bytes']! as int,
            licenseSpdx: item['licenseSpdx']! as String,
          );
        })
        .toList(growable: false);
    return FrozenSherpaManifest(
      setId: json['setId']! as String,
      platform: json['platform']! as String,
      architecture: json['architecture']! as String,
      contentKey: json['contentKey']! as String,
      licenseDisposition: json['licenseDisposition']! as String,
      distributionEligible: json['distributionEligible']! as bool,
      requiresUserAcceptance: json['requiresUserAcceptance']! as bool,
      minimumFreeBytesAfterInstall:
          json['minimumFreeBytesAfterInstall']! as int,
      downloads: downloads,
      files: files,
    );
  }

  final String setId;
  final String platform;
  final String architecture;
  final String contentKey;
  final String licenseDisposition;
  final bool distributionEligible;
  final bool requiresUserAcceptance;
  final int minimumFreeBytesAfterInstall;
  final List<FrozenSherpaDownload> downloads;
  final List<FrozenSherpaFile> files;

  int get downloadBytes => downloads.fold(0, (sum, item) => sum + item.bytes);
  int get installedBytes => files.fold(0, (sum, item) => sum + item.bytes);

  static const Set<(String, String)> _supportedTargets = {
    ('macos', 'arm64'),
    ('windows', 'x86_64'),
  };
}

class FrozenSenseVoiceManifest {
  FrozenSenseVoiceManifest({
    required this.setId,
    required this.platform,
    required this.architecture,
    required this.developmentPosture,
    required this.status,
    required this.distributionEligible,
    required this.developmentEligible,
    required this.licenseDisposition,
    required this.model,
    required this.vad,
    required this.control,
    required this.machineDecision,
  }) {
    if (!_id.hasMatch(setId) ||
        platform != 'macos' ||
        architecture != 'arm64' ||
        developmentPosture != 'DEVELOPMENT_ONLY' ||
        distributionEligible ||
        !developmentEligible ||
        licenseDisposition != 'LOCAL_DEVELOPMENT_BENCHMARK_ONLY' ||
        !const {
          'PENDING_U13_MACHINE_DECISION',
          'PASS',
          'UNAVAILABLE',
        }.contains(status)) {
      throw const FormatException('invalid frozen SenseVoice manifest');
    }
    _validateAssets();
    _validateControl();
    if (status == 'PASS') {
      final decision = machineDecision;
      if (decision == null ||
          decision['status'] != 'PASS' ||
          !_sha.hasMatch(decision['evidenceSha256'] as String? ?? '') ||
          decision['target'] != 'Mac16,10/Apple M4/macOS 15.7.5 (24G624)') {
        throw const FormatException(
          'SenseVoice PASS requires a target-bound machine decision',
        );
      }
    } else if (machineDecision != null) {
      throw const FormatException(
        'unavailable SenseVoice manifest cannot expose a decision',
      );
    }
  }

  factory FrozenSenseVoiceManifest.fromJson(Map<String, Object?> json) {
    if (json['schemaVersion'] != 1 ||
        json['model'] is! Map ||
        json['vad'] is! Map ||
        json['control'] is! Map ||
        (json['machineDecision'] != null && json['machineDecision'] is! Map)) {
      throw const FormatException('unsupported frozen SenseVoice manifest');
    }
    return FrozenSenseVoiceManifest(
      setId: json['setId']! as String,
      platform: json['platform']! as String,
      architecture: json['architecture']! as String,
      developmentPosture: json['developmentPosture']! as String,
      status: json['status']! as String,
      distributionEligible: json['distributionEligible']! as bool,
      developmentEligible: json['developmentEligible']! as bool,
      licenseDisposition: json['licenseDisposition']! as String,
      model: (json['model']! as Map).cast<String, Object?>(),
      vad: (json['vad']! as Map).cast<String, Object?>(),
      control: (json['control']! as Map).cast<String, Object?>(),
      machineDecision: json['machineDecision'] == null
          ? null
          : (json['machineDecision']! as Map).cast<String, Object?>(),
    );
  }

  final String setId;
  final String platform;
  final String architecture;
  final String developmentPosture;
  final String status;
  final bool distributionEligible;
  final bool developmentEligible;
  final String licenseDisposition;
  final Map<String, Object?> model;
  final Map<String, Object?> vad;
  final Map<String, Object?> control;
  final Map<String, Object?>? machineDecision;

  bool get exposesDevelopmentCapability => status == 'PASS';

  void _validateAssets() {
    final source = Uri.tryParse(model['source'] as String? ?? '');
    final vadSource = Uri.tryParse(vad['source'] as String? ?? '');
    if (source?.scheme != 'https' ||
        vadSource?.scheme != 'https' ||
        !_sha.hasMatch(model['archiveSha256'] as String? ?? '') ||
        !_sha.hasMatch(model['modelSha256'] as String? ?? '') ||
        !_sha.hasMatch(model['tokensSha256'] as String? ?? '') ||
        !_sha.hasMatch(vad['sha256'] as String? ?? '') ||
        ModelAssetManifest.pIsUnsafe(
          model['modelRelativePath'] as String? ?? '../invalid',
        ) ||
        ModelAssetManifest.pIsUnsafe(
          model['tokensRelativePath'] as String? ?? '../invalid',
        )) {
      throw const FormatException('invalid frozen SenseVoice assets');
    }
  }

  void _validateControl() {
    if (control['runtime'] != 'sherpa-onnx-1.13.4-ort-1.27.0' ||
        control['provider'] != 'cpu' ||
        control['threads'] != 2 ||
        control['concurrency'] != 1 ||
        control['decodingMethod'] != 'greedy_search' ||
        control['language'] != 'auto' ||
        control['useInverseTextNormalization'] != false ||
        control['maximumUtteranceSeconds'] != 15 ||
        control['publishesTokenPartials'] != false) {
      throw const FormatException('frozen SenseVoice control drifted');
    }
  }
}

abstract interface class FrozenSherpaFetcher {
  Future<void> fetch({
    required Uri source,
    required File destination,
    required int resumeFrom,
  });
}

class HttpsFrozenSherpaFetcher implements FrozenSherpaFetcher {
  const HttpsFrozenSherpaFetcher();

  static const _allowedHosts = {
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  };

  @override
  Future<void> fetch({
    required Uri source,
    required File destination,
    required int resumeFrom,
  }) async {
    var current = source;
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 30);
    try {
      for (var redirect = 0; redirect < 6; redirect += 1) {
        _requireTrusted(current);
        final request = await client.getUrl(current);
        request.followRedirects = false;
        if (resumeFrom > 0) request.headers.set('range', 'bytes=$resumeFrom-');
        final response = await request.close();
        if (response.isRedirect) {
          final location = response.headers.value('location');
          if (location == null) {
            throw StateError('model redirect has no destination');
          }
          current = current.resolve(location);
          await response.drain<void>();
          continue;
        }
        if (response.statusCode != HttpStatus.ok &&
            response.statusCode != HttpStatus.partialContent) {
          await response.drain<void>();
          throw HttpException(
            'model download failed with ${response.statusCode}',
            uri: current,
          );
        }
        final append =
            resumeFrom > 0 && response.statusCode == HttpStatus.partialContent;
        final sink = destination.openWrite(
          mode: append ? FileMode.append : FileMode.write,
        );
        await response.pipe(sink);
        return;
      }
      throw StateError('model download exceeded redirect limit');
    } finally {
      client.close(force: true);
    }
  }

  void _requireTrusted(Uri uri) {
    if (uri.scheme != 'https' ||
        uri.userInfo.isNotEmpty ||
        uri.hasPort && uri.port != 443 ||
        !_allowedHosts.contains(uri.host)) {
      throw StateError('model download origin is not trusted');
    }
  }
}

abstract interface class FrozenSherpaCapacityProbe {
  Future<int> availableBytes(Directory root);
}

class MacosFrozenSherpaCapacityProbe implements FrozenSherpaCapacityProbe {
  const MacosFrozenSherpaCapacityProbe();

  @override
  Future<int> availableBytes(Directory root) async {
    await root.create(recursive: true);
    final result = await Process.run('/bin/df', <String>['-Pk', root.path]);
    if (result.exitCode != 0) throw StateError('cannot inspect model volume');
    final lines = (result.stdout as String)
        .trim()
        .split('\n')
        .where((line) => line.trim().isNotEmpty)
        .toList();
    if (lines.length < 2) throw StateError('invalid model volume result');
    final columns = lines.last.trim().split(RegExp(r'\s+'));
    if (columns.length < 4) throw StateError('invalid model volume columns');
    return int.parse(columns[3]) * 1024;
  }
}

class FrozenSherpaInstallation {
  const FrozenSherpaInstallation({
    required this.root,
    required this.models,
    required this.reused,
  });

  final Directory root;
  final SherpaDesktopModelSet models;
  final bool reused;
}

class FrozenSherpaModelManager {
  const FrozenSherpaModelManager({
    required this.root,
    required this.fetcher,
    required this.capacityProbe,
    this.allowDevelopmentAssets = false,
  });

  final Directory root;
  final FrozenSherpaFetcher fetcher;
  final FrozenSherpaCapacityProbe capacityProbe;
  final bool allowDevelopmentAssets;

  Future<FrozenSherpaInstallation?> inspect(
    FrozenSherpaManifest manifest,
  ) async {
    if (!manifest.distributionEligible && !allowDevelopmentAssets) return null;
    final installed = _installedRoot(manifest);
    if (!await installed.exists()) return null;
    try {
      await _verifyInstalled(manifest, installed);
      return FrozenSherpaInstallation(
        root: installed,
        models: _models(installed),
        reused: true,
      );
    } on Object {
      return null;
    }
  }

  Future<FrozenSherpaInstallation> install(
    FrozenSherpaManifest manifest, {
    void Function(double progress)? onProgress,
  }) async {
    if (!manifest.distributionEligible && !allowDevelopmentAssets) {
      throw StateError('MODEL_LICENSE_REVIEW_REQUIRED');
    }
    final existing = await inspect(manifest);
    if (existing != null) return existing;
    await root.create(recursive: true);
    final required =
        manifest.downloadBytes +
        manifest.installedBytes * 2 +
        manifest.minimumFreeBytesAfterInstall;
    if (await capacityProbe.availableBytes(root) < required) {
      throw StateError('MODEL_INSTALL_INSUFFICIENT_SPACE');
    }
    final staging = Directory(
      p.join(root.path, 'staging', '${manifest.contentKey}.partial'),
    );
    final downloadsRoot = Directory(p.join(staging.path, 'downloads'));
    await downloadsRoot.create(recursive: true);
    var completedBytes = 0;
    for (final download in manifest.downloads) {
      final destination = File(p.join(downloadsRoot.path, download.id));
      var resumeFrom = await destination.exists()
          ? await destination.length()
          : 0;
      if (resumeFrom > download.bytes) {
        await destination.delete();
        resumeFrom = 0;
      }
      if (resumeFrom < download.bytes) {
        await fetcher.fetch(
          source: download.source,
          destination: destination,
          resumeFrom: resumeFrom,
        );
      }
      await _verifyFile(destination, download.sha256, download.bytes);
      completedBytes += download.bytes;
      onProgress?.call(completedBytes / manifest.downloadBytes * 0.7);
    }
    final prepared = Directory(p.join(staging.path, 'prepared'));
    if (await prepared.exists()) await prepared.delete(recursive: true);
    await prepared.create(recursive: true);
    final extracted = <String, Directory>{};
    for (final download in manifest.downloads.where(
      (item) => item.kind == 'tar.bz2',
    )) {
      final destination = Directory(
        p.join(staging.path, 'extract', download.id),
      );
      if (await destination.exists()) {
        await destination.delete(recursive: true);
      }
      await destination.create(recursive: true);
      final result = await Process.run('/usr/bin/tar', <String>[
        '-xjf',
        p.join(downloadsRoot.path, download.id),
        '-C',
        destination.path,
      ]);
      if (result.exitCode != 0) {
        throw StateError('MODEL_ARCHIVE_EXTRACTION_FAILED');
      }
      extracted[download.id] = destination;
    }
    for (var index = 0; index < manifest.files.length; index += 1) {
      final file = manifest.files[index];
      final download = manifest.downloads.firstWhere(
        (item) => item.id == file.downloadId,
      );
      final source = download.kind == 'file'
          ? File(p.join(downloadsRoot.path, download.id))
          : File(p.join(extracted[download.id]!.path, file.archiveMember));
      final destination = File(p.join(prepared.path, file.relativePath));
      await destination.parent.create(recursive: true);
      await source.openRead().pipe(destination.openWrite());
      await _verifyFile(destination, file.sha256, file.bytes);
      onProgress?.call(0.7 + (index + 1) / manifest.files.length * 0.3);
    }
    await File(p.join(prepared.path, '.receipt.json')).writeAsString(
      '${jsonEncode(<String, Object?>{
        'schemaVersion': 1,
        'setId': manifest.setId,
        'contentKey': manifest.contentKey,
        'installedAtMs': DateTime.now().millisecondsSinceEpoch,
        'files': manifest.files.map((file) => <String, Object?>{'relativePath': file.relativePath, 'sha256': file.sha256, 'bytes': file.bytes, 'licenseSpdx': file.licenseSpdx}).toList(),
      })}\n',
      flush: true,
    );
    final installed = _installedRoot(manifest);
    await installed.parent.create(recursive: true);
    if (await installed.exists()) {
      final quarantine = Directory(
        p.join(
          root.path,
          'quarantine',
          '${manifest.contentKey}-${DateTime.now().microsecondsSinceEpoch}',
        ),
      );
      await quarantine.parent.create(recursive: true);
      await installed.rename(quarantine.path);
    }
    await prepared.rename(installed.path);
    await _verifyInstalled(manifest, installed);
    if (await staging.exists()) await staging.delete(recursive: true);
    return FrozenSherpaInstallation(
      root: installed,
      models: _models(installed),
      reused: false,
    );
  }

  Future<void> uninstall(FrozenSherpaManifest manifest) async {
    final installed = _installedRoot(manifest);
    if (await installed.exists()) await installed.delete(recursive: true);
  }

  Future<void> _verifyInstalled(
    FrozenSherpaManifest manifest,
    Directory installed,
  ) async {
    for (final file in manifest.files) {
      await _verifyFile(
        File(p.join(installed.path, file.relativePath)),
        file.sha256,
        file.bytes,
      );
    }
    final receipt = File(p.join(installed.path, '.receipt.json'));
    if (!await receipt.exists()) throw StateError('model receipt missing');
    final value = jsonDecode(await receipt.readAsString());
    if (value is! Map ||
        value['setId'] != manifest.setId ||
        value['contentKey'] != manifest.contentKey) {
      throw StateError('model receipt identity mismatch');
    }
  }

  Future<void> _verifyFile(File file, String expectedSha, int bytes) async {
    if (!await file.exists() || await file.length() != bytes) {
      throw StateError('MODEL_FILE_SIZE_MISMATCH');
    }
    final digest = (await sha256.bind(file.openRead()).first).toString();
    if (digest != expectedSha) throw StateError('MODEL_FILE_HASH_MISMATCH');
  }

  Directory _installedRoot(FrozenSherpaManifest manifest) =>
      Directory(p.join(root.path, 'sets', manifest.contentKey));

  SherpaDesktopModelSet _models(Directory installed) => SherpaDesktopModelSet(
    convFrontendPath: p.join(installed.path, 'asr', 'conv_frontend.onnx'),
    encoderPath: p.join(installed.path, 'asr', 'encoder.int8.onnx'),
    decoderPath: p.join(installed.path, 'asr', 'decoder.int8.onnx'),
    tokenizerPath: p.join(installed.path, 'asr', 'tokenizer'),
    vadPath: p.join(installed.path, 'asr', 'silero_vad.onnx'),
    segmentationPath: p.join(
      installed.path,
      'diarization',
      'segmentation.onnx',
    ),
    embeddingPath: p.join(installed.path, 'diarization', 'embedding.onnx'),
  );
}

final _id = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$');
final _sha = RegExp(r'^[0-9a-f]{64}$');
