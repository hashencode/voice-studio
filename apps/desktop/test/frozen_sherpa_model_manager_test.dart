import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:voice2text_desktop/features/processing/frozen_sherpa_model_manager.dart';

void main() {
  late Directory temporary;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('frozen-sherpa-test-');
  });

  tearDown(() async {
    if (await temporary.exists()) {
      await temporary.delete(recursive: true);
    }
  });

  test('macOS product manifest contains one Qwen3 ASR model profile', () async {
    final manifestFile = <File>[
      File('assets/processing/frozen_sherpa_macos_arm64.json'),
      File('apps/desktop/assets/processing/frozen_sherpa_macos_arm64.json'),
    ].firstWhere((candidate) => candidate.existsSync());
    final raw = jsonDecode(await manifestFile.readAsString());
    final manifest = FrozenSherpaManifest.fromJson(
      (raw as Map).cast<String, Object?>(),
    );

    expect(manifest.setId, contains('qwen3-asr-0.6b-int8'));
    expect(manifest.licenseDisposition, contains('REVIEW_REQUIRED'));
    expect(manifest.distributionEligible, isFalse);
    expect(
      manifest.downloads
          .where((download) => download.id == 'qwen3-asr-archive')
          .single
          .sha256,
      '393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96',
    );
    final paths = manifest.files.map((file) => file.relativePath).toSet();
    expect(
      paths,
      containsAll(<String>{
        'asr/conv_frontend.onnx',
        'asr/encoder.int8.onnx',
        'asr/decoder.int8.onnx',
        'asr/tokenizer/tokenizer_config.json',
        'asr/tokenizer/merges.txt',
        'asr/tokenizer/vocab.json',
      }),
    );
    expect(paths.any((path) => path.contains('zipformer')), isFalse);
    expect(paths.any((path) => path.endsWith('joiner.onnx')), isFalse);
  });

  test(
    'resumes, verifies, atomically activates, reuses and uninstalls',
    () async {
      final bytes = utf8.encode('pinned-model-bytes');
      final digest = sha256.convert(bytes).toString();
      final manifest = _manifest(digest: digest, bytes: bytes.length);
      final fetcher = _MemoryFetcher(bytes);
      final root = Directory(p.join(temporary.path, 'models'));
      final manager = FrozenSherpaModelManager(
        root: root,
        fetcher: fetcher,
        capacityProbe: const _CapacityProbe(1 << 30),
      );
      final partial = File(
        p.join(
          root.path,
          'staging',
          '${manifest.contentKey}.partial',
          'downloads',
          'encoder-model',
        ),
      );
      await partial.parent.create(recursive: true);
      await partial.writeAsBytes(bytes.sublist(0, 4));
      final progress = <double>[];

      final installed = await manager.install(
        manifest,
        onProgress: progress.add,
      );

      expect(installed.reused, isFalse);
      expect(fetcher.resumeOffsets, <int>[4]);
      expect(
        await File(
          p.join(installed.root.path, 'asr', 'encoder.onnx'),
        ).readAsBytes(),
        bytes,
      );
      expect(progress.last, 1);
      expect(
        await Directory(
          p.join(root.path, 'staging', '${manifest.contentKey}.partial'),
        ).exists(),
        isFalse,
      );
      expect((await manager.inspect(manifest))?.reused, isTrue);
      expect((await manager.install(manifest)).reused, isTrue);
      expect(fetcher.resumeOffsets, hasLength(1));

      await manager.uninstall(manifest);
      expect(await manager.inspect(manifest), isNull);
    },
  );

  test(
    'corrupt active set is quarantined and repaired from pinned bytes',
    () async {
      final bytes = utf8.encode('verified-model');
      final digest = sha256.convert(bytes).toString();
      final manifest = _manifest(digest: digest, bytes: bytes.length);
      final root = Directory(p.join(temporary.path, 'models'));
      final manager = FrozenSherpaModelManager(
        root: root,
        fetcher: _MemoryFetcher(bytes),
        capacityProbe: const _CapacityProbe(1 << 30),
      );
      final first = await manager.install(manifest);
      await File(
        p.join(first.root.path, 'asr', 'encoder.onnx'),
      ).writeAsString('corrupt');

      expect(await manager.inspect(manifest), isNull);
      final repaired = await manager.install(manifest);

      expect(repaired.reused, isFalse);
      expect(
        sha256
            .convert(
              await File(
                p.join(repaired.root.path, 'asr', 'encoder.onnx'),
              ).readAsBytes(),
            )
            .toString(),
        digest,
      );
      final quarantine = Directory(p.join(root.path, 'quarantine'));
      expect(await quarantine.exists(), isTrue);
      expect(await quarantine.list().isEmpty, isFalse);
    },
  );

  test('fails closed on capacity, insecure origins and unsafe paths', () async {
    final bytes = utf8.encode('model');
    final digest = sha256.convert(bytes).toString();
    final manifest = _manifest(digest: digest, bytes: bytes.length);
    final fetcher = _MemoryFetcher(bytes);
    final manager = FrozenSherpaModelManager(
      root: Directory(p.join(temporary.path, 'models')),
      fetcher: fetcher,
      capacityProbe: const _CapacityProbe(0),
    );

    await expectLater(manager.install(manifest), throwsA(isA<StateError>()));
    expect(fetcher.resumeOffsets, isEmpty);
    expect(
      () => FrozenSherpaManifest.fromJson(<String, Object?>{
        ..._manifestJson(digest: digest, bytes: bytes.length),
        'downloads': <Object?>[
          <String, Object?>{
            'id': 'encoder-model',
            'source': 'http://example.com/model.onnx',
            'sha256': digest,
            'bytes': bytes.length,
            'kind': 'file',
          },
        ],
      }),
      throwsFormatException,
    );
    expect(
      () => FrozenSherpaManifest.fromJson(<String, Object?>{
        ..._manifestJson(digest: digest, bytes: bytes.length),
        'files': <Object?>[
          <String, Object?>{
            'relativePath': '../escape.onnx',
            'downloadId': 'encoder-model',
            'sha256': digest,
            'bytes': bytes.length,
            'licenseSpdx': 'MIT',
          },
        ],
      }),
      throwsFormatException,
    );
  });

  test('capacity gate reserves download plus two installed copies', () async {
    final bytes = utf8.encode('model');
    final digest = sha256.convert(bytes).toString();
    final manifest = _manifest(digest: digest, bytes: bytes.length);
    final required =
        manifest.downloadBytes +
        manifest.installedBytes * 2 +
        manifest.minimumFreeBytesAfterInstall;
    final fetcher = _MemoryFetcher(bytes);
    final manager = FrozenSherpaModelManager(
      root: Directory(p.join(temporary.path, 'capacity-models')),
      fetcher: fetcher,
      capacityProbe: _CapacityProbe(required - 1),
    );

    await expectLater(manager.install(manifest), throwsA(isA<StateError>()));
    expect(fetcher.resumeOffsets, isEmpty);
  });

  test(
    'blocks license-review assets before fetch unless locally enabled',
    () async {
      final bytes = utf8.encode('model');
      final digest = sha256.convert(bytes).toString();
      final manifest = FrozenSherpaManifest.fromJson(<String, Object?>{
        ..._manifestJson(digest: digest, bytes: bytes.length),
        'licenseDisposition':
            'PRODUCT_ELIGIBLE_WITH_PINNED_NOTICES_CONVERTER_LICENSE_REVIEW_REQUIRED',
        'distributionEligible': false,
      });
      final fetcher = _MemoryFetcher(bytes);
      final manager = FrozenSherpaModelManager(
        root: Directory(p.join(temporary.path, 'blocked-models')),
        fetcher: fetcher,
        capacityProbe: const _CapacityProbe(1 << 30),
      );

      expect(await manager.inspect(manifest), isNull);
      await expectLater(
        manager.install(manifest),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            'MODEL_LICENSE_REVIEW_REQUIRED',
          ),
        ),
      );
      expect(fetcher.resumeOffsets, isEmpty);
    },
  );

  test(
    'accepts only target-specific macOS arm64 or Windows x86_64 manifests',
    () {
      final bytes = utf8.encode('model');
      final digest = sha256.convert(bytes).toString();
      final base = _manifestJson(digest: digest, bytes: bytes.length);

      final windows = FrozenSherpaManifest.fromJson(<String, Object?>{
        ...base,
        'platform': 'windows',
        'architecture': 'x86_64',
      });

      expect(windows.platform, 'windows');
      expect(windows.architecture, 'x86_64');
      for (final unsupported in <(String, String)>[
        ('macos', 'x86_64'),
        ('windows', 'arm64'),
        ('linux', 'x86_64'),
      ]) {
        expect(
          () => FrozenSherpaManifest.fromJson(<String, Object?>{
            ...base,
            'platform': unsupported.$1,
            'architecture': unsupported.$2,
          }),
          throwsFormatException,
          reason: '${unsupported.$1}/${unsupported.$2} must remain blocked',
        );
      }
    },
  );
}

FrozenSherpaManifest _manifest({required String digest, required int bytes}) =>
    FrozenSherpaManifest.fromJson(_manifestJson(digest: digest, bytes: bytes));

Map<String, Object?> _manifestJson({
  required String digest,
  required int bytes,
}) => <String, Object?>{
  'schemaVersion': 1,
  'setId': 'test-set',
  'platform': 'macos',
  'architecture': 'arm64',
  'contentKey':
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'licenseDisposition': 'PRODUCT_ELIGIBLE_WITH_PINNED_NOTICES',
  'distributionEligible': true,
  'requiresUserAcceptance': false,
  'minimumFreeBytesAfterInstall': 1,
  'downloads': <Object?>[
    <String, Object?>{
      'id': 'encoder-model',
      'source': 'https://github.com/example/model.onnx',
      'sha256': digest,
      'bytes': bytes,
      'kind': 'file',
    },
  ],
  'files': <Object?>[
    <String, Object?>{
      'relativePath': 'asr/encoder.onnx',
      'downloadId': 'encoder-model',
      'sha256': digest,
      'bytes': bytes,
      'licenseSpdx': 'MIT',
    },
  ],
};

class _MemoryFetcher implements FrozenSherpaFetcher {
  _MemoryFetcher(this.bytes);

  final List<int> bytes;
  final List<int> resumeOffsets = <int>[];

  @override
  Future<void> fetch({
    required Uri source,
    required File destination,
    required int resumeFrom,
  }) async {
    resumeOffsets.add(resumeFrom);
    await destination.parent.create(recursive: true);
    await destination.writeAsBytes(
      bytes.sublist(resumeFrom),
      mode: resumeFrom == 0 ? FileMode.write : FileMode.append,
      flush: true,
    );
  }
}

class _CapacityProbe implements FrozenSherpaCapacityProbe {
  const _CapacityProbe(this.bytes);

  final int bytes;

  @override
  Future<int> availableBytes(Directory root) async => bytes;
}
