import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_runtime_manager.dart';

void main() {
  late Directory temporary;
  late _Fetcher fetcher;
  late SidecarRuntimeManager manager;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('sidecar-runtime-');
    fetcher = _Fetcher();
    manager = SidecarRuntimeManager(
      root: Directory('${temporary.path}/managed'),
      platform: 'macos',
      architecture: 'arm64',
      fetcher: fetcher,
      capacityProbe: const _Capacity(1 << 40),
    );
  });

  tearDown(() async {
    await temporary.delete(recursive: true);
  });

  test(
    'provision resumes, verifies, atomically activates and reuses',
    () async {
      final manifest = _manifest('v1', <int>[1, 2, 3]);
      final staging = File(
        '${manager.root.path}/staging/${manifest.contentKey}.partial/bin/tool',
      );
      await staging.parent.create(recursive: true);
      await staging.writeAsBytes(<int>[1]);

      final first = await manager.provision(manifest);
      final second = await manager.provision(manifest);

      expect(first.reused, isFalse);
      expect(second.reused, isTrue);
      expect(fetcher.resumeOffsets, <int>[1]);
      expect(
        File('${first.runtimeRoot.path}/bin/tool').readAsBytesSync(),
        <int>[1, 2, 3],
      );
    },
  );

  test('hash mismatch is quarantined and repaired', () async {
    final manifest = _manifest('v1', <int>[4, 5, 6]);
    final installed = await manager.provision(manifest);
    await File('${installed.runtimeRoot.path}/bin/tool').writeAsBytes(<int>[0]);

    final repaired = await manager.repair(manifest);

    expect(repaired.reused, isFalse);
    expect(
      File('${repaired.runtimeRoot.path}/bin/tool').readAsBytesSync(),
      <int>[4, 5, 6],
    );
    expect(
      Directory('${manager.root.path}/quarantine').listSync(),
      hasLength(1),
    );
  });

  test('upgrade can roll back, prune, and uninstall', () async {
    final first = _manifest('v1', <int>[1]);
    final second = _manifest('v2', <int>[2]);
    await manager.provision(first);
    await manager.provision(second);

    await manager.rollback(first.runtimeId);
    await manager.prune();
    expect(
      Directory(
        '${manager.root.path}/runtimes/${first.contentKey}',
      ).existsSync(),
      isTrue,
    );
    expect(
      Directory(
        '${manager.root.path}/runtimes/${second.contentKey}',
      ).existsSync(),
      isTrue,
    );

    await manager.uninstall(first.runtimeId);
    expect(Directory('${manager.root.path}/runtimes').listSync(), isEmpty);
  });

  test(
    'target, capacity, and user conditions fail closed before fetch',
    () async {
      final blocked = _manifest(
        'blocked',
        <int>[1],
        licenseDisposition: 'LAB_ONLY_USER_CONDITIONS_NOT_ACCEPTED',
        requiresUserAcceptance: true,
        userConditionsAccepted: false,
      );
      await expectLater(
        manager.provision(blocked),
        throwsA(
          isA<SidecarProtocolException>().having(
            (error) => error.code,
            'code',
            'SIDECAR_RUNTIME_LICENSE_BLOCKED',
          ),
        ),
      );
      final noSpace = SidecarRuntimeManager(
        root: Directory('${temporary.path}/no-space'),
        platform: 'macos',
        architecture: 'arm64',
        fetcher: fetcher,
        capacityProbe: const _Capacity(0),
      );
      await expectLater(
        noSpace.provision(_manifest('large', <int>[1])),
        throwsA(
          isA<SidecarProtocolException>().having(
            (error) => error.code,
            'code',
            'SIDECAR_RUNTIME_INSUFFICIENT_SPACE',
          ),
        ),
      );
      expect(fetcher.resumeOffsets, isEmpty);
    },
  );
}

SidecarRuntimeManifest _manifest(
  String version,
  List<int> bytes, {
  String licenseDisposition = 'PRODUCT_REVIEW_ELIGIBLE',
  bool requiresUserAcceptance = false,
  bool userConditionsAccepted = true,
}) {
  final digest = sha256.convert(bytes).toString();
  return SidecarRuntimeManifest(
    runtimeId: 'fixture-runtime',
    runtimeVersion: version,
    platform: 'macos',
    architecture: 'arm64',
    contentKey: sha256.convert('manifest-$version'.codeUnits).toString(),
    licenseDisposition: licenseDisposition,
    requiresUserAcceptance: requiresUserAcceptance,
    userConditionsAccepted: userConditionsAccepted,
    minimumFreeBytesAfterInstall: 0,
    artifacts: <SidecarRuntimeArtifact>[
      SidecarRuntimeArtifact(
        relativePath: 'bin/tool',
        source: Uri.parse(
          'https://example.invalid/$version/tool?bytes=${bytes.join(',')}',
        ),
        sha256: digest,
        bytes: bytes.length,
      ),
    ],
  );
}

class _Fetcher implements SidecarArtifactFetcher {
  final List<int> resumeOffsets = <int>[];

  @override
  Future<void> fetch({
    required Uri source,
    required File destination,
    required int resumeFrom,
  }) async {
    resumeOffsets.add(resumeFrom);
    final bytes = source.queryParameters['bytes']!
        .split(',')
        .map(int.parse)
        .toList(growable: false);
    await destination.writeAsBytes(
      bytes.skip(resumeFrom).toList(),
      mode: FileMode.append,
    );
  }
}

class _Capacity implements SidecarCapacityProbe {
  const _Capacity(this.bytes);

  final int bytes;

  @override
  Future<int> availableBytes(Directory root) async => bytes;
}
