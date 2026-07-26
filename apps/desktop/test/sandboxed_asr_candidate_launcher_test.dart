import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_sandbox.dart';

import '../tool/asr_benchmark/sandboxed_candidate_launcher.dart';

void main() {
  late Directory temporary;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp(
      'sandboxed-asr-launcher-',
    );
  });

  tearDown(() async {
    await temporary.delete(recursive: true);
  });

  test('launch command enters process-group launcher before sandbox', () async {
    final roots = await createRoots(temporary);
    final launcher = File('${roots.toolRoot}/launcher')..writeAsStringSync('x');
    final worker = File('${roots.toolRoot}/worker')..writeAsStringSync('x');
    final candidate = SandboxedCandidateLauncher(
      roots: roots,
      nativeProcessGroupLauncher: launcher,
      worker: worker,
    );
    final command = candidate.launchCommand;
    expect(command.first, launcher.path);
    expect(command[1], sandboxExecutable);
    expect(command[2], '-p');
    expect(command[3], contains('(deny network*)'));
    expect(command[4], worker.path);
    expect(command.sublist(5), <String>['--runtime-root', roots.runtimeRoot]);
    expect(
      candidate.minimalEnvironment().keys,
      unorderedEquals(<String>[
        'PATH',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'HF_HUB_OFFLINE',
        'HF_HUB_DISABLE_TELEMETRY',
        'MODELSCOPE_OFFLINE',
      ]),
    );
  });

  test('overlapping roots fail before a sandbox command is built', () async {
    final job = await Directory('${temporary.path}/job').create();
    final nested = await Directory('${job.path}/runtime').create();
    final model = await Directory('${temporary.path}/model').create();
    final tools = await Directory('${temporary.path}/tools').create();
    await expectLater(
      SidecarRoots.resolve(
        jobRoot: job,
        runtimeRoot: nested,
        modelRoot: model,
        toolRoot: tools,
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_ROOT_COLLISION',
        ),
      ),
    );
  });

  test('missing sandbox is fail closed', () async {
    final roots = await createRoots(temporary);
    final executable = File('${roots.toolRoot}/worker')..writeAsStringSync('x');
    final candidate = SandboxedCandidateLauncher(
      roots: roots,
      nativeProcessGroupLauncher: executable,
      worker: executable,
      sandboxPath: '${temporary.path}/missing-sandbox-exec',
    );
    await expectLater(
      candidate.validate(),
      throwsA(
        isA<StateError>().having(
          (error) => error.message,
          'message',
          'BENCHMARK_SANDBOX_UNAVAILABLE',
        ),
      ),
    );
  });

  test('worker source and models must stay inside allowlisted roots', () async {
    final roots = await createRoots(temporary);
    final executable = File('${roots.toolRoot}/worker')..writeAsStringSync('x');
    final source = File('${roots.jobRoot}/input.wav')
      ..writeAsBytesSync(<int>[1]);
    final model = File('${roots.modelRoot}/model.onnx')
      ..writeAsBytesSync(<int>[2]);
    final candidate = SandboxedCandidateLauncher(
      roots: roots,
      nativeProcessGroupLauncher: executable,
      worker: executable,
    );
    final request = <String, Object?>{
      'sourcePath': source.path,
      'modelFiles': <String, Object?>{
        'model': <String, Object?>{
          'path': model.path,
          'sha256': List<String>.filled(64, 'a').join(),
        },
      },
    };
    await expectLater(candidate.validateWorkerRequest(request), completes);
    final outside = File('${temporary.path}/outside.onnx')
      ..writeAsBytesSync(<int>[3]);
    await expectLater(
      candidate.validateWorkerRequest(<String, Object?>{
        ...request,
        'modelFiles': <String, Object?>{
          'model': <String, Object?>{
            'path': outside.path,
            'sha256': List<String>.filled(64, 'a').join(),
          },
        },
      }),
      throwsA(isA<FileSystemException>()),
    );
  });

  test(
    'active macOS probe proves network and user-home permission denial',
    () async {
      final roots = await createRoots(temporary);
      final launcher = File('${roots.toolRoot}/launcher')
        ..writeAsStringSync('x');
      final worker = File('${roots.toolRoot}/worker')..writeAsStringSync('x');
      final candidate = SandboxedCandidateLauncher(
        roots: roots,
        nativeProcessGroupLauncher: launcher,
        worker: worker,
      );
      final evidence = await candidate.activeDenialProbe();
      expect(evidence.networkPermissionDenied, isTrue);
      expect(evidence.userHomePermissionDenied, isTrue);
      expect(evidence.admitted, isTrue);
    },
    skip: !Platform.isMacOS || !File(sandboxExecutable).existsSync(),
  );
}

Future<SidecarRoots> createRoots(Directory temporary) async {
  final job = await Directory('${temporary.path}/job').create();
  final runtime = await Directory('${temporary.path}/runtime').create();
  final model = await Directory('${temporary.path}/model').create();
  final tools = await Directory('${temporary.path}/tools').create();
  return SidecarRoots.resolve(
    jobRoot: job,
    runtimeRoot: runtime,
    modelRoot: model,
    toolRoot: tools,
  );
}
