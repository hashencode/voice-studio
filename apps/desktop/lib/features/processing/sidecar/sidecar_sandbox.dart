import 'dart:io';

import 'package:path/path.dart' as path;
import 'package:processing_contracts/processing_contracts.dart';

class SidecarRoots {
  const SidecarRoots._({
    required this.jobRoot,
    required this.runtimeRoot,
    required this.modelRoot,
    required this.toolRoot,
  });

  final String jobRoot;
  final String runtimeRoot;
  final String modelRoot;
  final String toolRoot;

  static Future<SidecarRoots> resolve({
    required Directory jobRoot,
    required Directory runtimeRoot,
    required Directory modelRoot,
    required Directory toolRoot,
  }) async {
    final resolved = <String>[
      await jobRoot.resolveSymbolicLinks(),
      await runtimeRoot.resolveSymbolicLinks(),
      await modelRoot.resolveSymbolicLinks(),
      await toolRoot.resolveSymbolicLinks(),
    ].map(path.normalize).toList(growable: false);
    if (resolved.toSet().length != resolved.length) {
      throw const SidecarProtocolException(
        'SIDECAR_ROOT_COLLISION',
        'Sidecar roots must be distinct.',
      );
    }
    for (var left = 0; left < resolved.length; left += 1) {
      for (var right = left + 1; right < resolved.length; right += 1) {
        if (_isContained(resolved[left], resolved[right]) ||
            _isContained(resolved[right], resolved[left])) {
          throw const SidecarProtocolException(
            'SIDECAR_ROOT_COLLISION',
            'Sidecar roots cannot contain each other.',
          );
        }
      }
    }
    return SidecarRoots._(
      jobRoot: resolved[0],
      runtimeRoot: resolved[1],
      modelRoot: resolved[2],
      toolRoot: resolved[3],
    );
  }

  Future<String> requireContainedSource(File source) async {
    final resolved = path.normalize(await source.resolveSymbolicLinks());
    if (!_isContained(jobRoot, resolved) || resolved == jobRoot) {
      throw const SidecarProtocolException(
        'SIDECAR_PATH_ESCAPE',
        'Sidecar source is outside the job root.',
      );
    }
    final stat = await source.stat();
    if (stat.type != FileSystemEntityType.file) {
      throw const SidecarProtocolException(
        'SIDECAR_SOURCE_IDENTITY_INVALID',
        'Sidecar source must be a regular file.',
      );
    }
    return path.relative(resolved, from: jobRoot);
  }
}

class SidecarSandboxProfile {
  const SidecarSandboxProfile._();

  static String macos(SidecarRoots roots) {
    final job = _quote(roots.jobRoot);
    final runtime = _quote(roots.runtimeRoot);
    final model = _quote(roots.modelRoot);
    final tools = _quote(roots.toolRoot);
    final userRoot = _quote(
      path.normalize(
        Platform.environment['HOME'] ??
            (throw const SidecarProtocolException(
              'SIDECAR_SANDBOX_UNAVAILABLE',
              'User data root is unavailable.',
            )),
      ),
    );
    return '''
(version 1)
(allow default)
(deny network*)
(deny file-read*
  (require-all
    (subpath $userRoot)
    (require-not (subpath $runtime))
    (require-not (subpath $model))
    (require-not (subpath $tools))
    (require-not (subpath $job))))
(deny file-write*
  (require-all
    (subpath $userRoot)
    (require-not (subpath $job))))
(deny file-write* (subpath "/tmp"))
(deny file-write* (subpath "/private/tmp"))
''';
  }

  static String _quote(String value) {
    if (value.contains('\n') || value.contains('\r') || value.contains('"')) {
      throw const SidecarProtocolException(
        'SIDECAR_PATH_ESCAPE',
        'Sidecar root cannot be represented in a sandbox profile.',
      );
    }
    return '"${value.replaceAll(r'\', r'\\')}"';
  }
}

bool _isContained(String root, String candidate) =>
    path.isWithin(root, candidate);
