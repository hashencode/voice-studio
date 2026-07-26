import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_process_client.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_sandbox.dart';

void main() {
  late Directory temporary;
  late String projectRoot;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('sidecar-client-');
    final current = Directory.current;
    final nestedDesktop = Directory('${current.path}/apps/desktop');
    projectRoot = nestedDesktop.existsSync()
        ? nestedDesktop.path
        : current.path;
  });

  tearDown(() async {
    await temporary.delete(recursive: true);
  });

  for (final mode in <String>['valid', 'sandbox']) {
    test('$mode sidecar returns only a validated current result', () async {
      final fixture = await _fixture(
        temporary,
        projectRoot,
        mode: mode,
        useSandbox: mode == 'sandbox',
      );
      final progress = <ProcessingProgress>[];
      final outcome = await const SidecarProcessClient().run(
        configuration: fixture.configuration,
        request: fixture.request,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: progress.add,
      );

      expect(outcome.transcript?.segments.single.text, 'fixture');
      expect(progress.single.fraction, 0.5);
    });
  }

  test('version mismatch fails closed before sending a job', () async {
    final fixture = await _fixture(
      temporary,
      projectRoot,
      mode: 'version-mismatch',
    );
    await expectLater(
      const SidecarProcessClient().run(
        configuration: fixture.configuration,
        request: fixture.request,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: (_) {},
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_VERSION_MISMATCH',
        ),
      ),
    );
  });

  for (final entry in <String, String>{
    'stale': 'SIDECAR_STALE_RESULT',
    'oversize': 'SIDECAR_OUTPUT_LIMIT',
    'crash': 'SIDECAR_PROCESS_EXITED',
  }.entries) {
    test('${entry.key} sidecar cannot publish a result', () async {
      final fixture = await _fixture(temporary, projectRoot, mode: entry.key);
      await expectLater(
        const SidecarProcessClient().run(
          configuration: fixture.configuration,
          request: fixture.request,
          cancellationToken: ProcessingCancellationToken(),
          onProgress: (_) {},
        ),
        throwsA(
          isA<SidecarProtocolException>().having(
            (error) => error.code,
            'code',
            entry.value,
          ),
        ),
      );
    });
  }

  test('timeout kills native work and a clean retry succeeds', () async {
    final hanging = await _fixture(
      temporary,
      projectRoot,
      mode: 'hang',
      timeout: const Duration(milliseconds: 250),
    );
    await expectLater(
      const SidecarProcessClient().run(
        configuration: hanging.configuration,
        request: hanging.request,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: (_) {},
      ),
      throwsA(isA<ProcessingTimedOut>()),
    );

    final retry = await _fixture(temporary, projectRoot, mode: 'valid');
    final outcome = await const SidecarProcessClient().run(
      configuration: retry.configuration,
      request: retry.request,
      cancellationToken: ProcessingCancellationToken(),
      onProgress: (_) {},
    );
    expect(outcome.transcript?.segments.single.text, 'fixture');
  });

  test('cancellation kills native work without publishing a result', () async {
    final hanging = await _fixture(
      temporary,
      projectRoot,
      mode: 'hang',
      timeout: const Duration(seconds: 5),
    );
    final token = ProcessingCancellationToken();
    final run = const SidecarProcessClient().run(
      configuration: hanging.configuration,
      request: hanging.request,
      cancellationToken: token,
      onProgress: (_) {},
    );
    await Future<void>.delayed(const Duration(milliseconds: 150));
    token.cancel();
    await expectLater(run, throwsA(isA<ProcessingCancelled>()));
  });

  test('resident-memory limit terminates an oversized worker', () async {
    final memory = await _fixture(
      temporary,
      projectRoot,
      mode: 'memory',
      memoryBytes: 64 * 1024 * 1024,
    );
    await expectLater(
      const SidecarProcessClient().run(
        configuration: memory.configuration,
        request: memory.request,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: (_) {},
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_MEMORY_LIMIT',
        ),
      ),
    );
  });
}

Future<({SidecarLaunchConfiguration configuration, SidecarJobRequest request})>
_fixture(
  Directory temporary,
  String projectRoot, {
  required String mode,
  bool useSandbox = false,
  Duration timeout = const Duration(seconds: 5),
  int memoryBytes = 512 * 1024 * 1024,
}) async {
  final job = await Directory('${temporary.path}/job-$mode').create();
  final runtime = Directory('/Applications/Xcode.app/Contents/Developer');
  const pythonPath =
      '/Applications/Xcode.app/Contents/Developer/usr/bin/python3';
  final model = await Directory('${temporary.path}/model-$mode').create();
  final tools = Directory('$projectRoot/tool/processing_sidecar');
  File('${job.path}/fixture-mode').writeAsStringSync(mode);
  File('${job.path}/source.wav').writeAsBytesSync(<int>[1]);
  final roots = await SidecarRoots.resolve(
    jobRoot: job,
    runtimeRoot: runtime,
    modelRoot: model,
    toolRoot: tools,
  );
  return (
    configuration: SidecarLaunchConfiguration(
      roots: roots,
      launcherPath: '${tools.path}/launcher.py',
      workerPath: '${tools.path}/contract_fixture.py',
      pythonPath: pythonPath,
      engine: 'funasr',
      expectedRuntimeId: 'fixture',
      expectedRuntimeVersion: 'fixture-1',
      requiredCapabilities: const <String>{'asr.zh'},
      timeout: timeout,
      cpuSeconds: 5,
      memoryBytes: memoryBytes,
      outputBytes: 2 * 1024 * 1024,
      useMacosSandbox: useSandbox,
    ),
    request: SidecarJobRequest(
      jobId: 'job-$mode',
      attemptId: 'attempt-$mode',
      sourceRelativePath: 'source.wav',
      sourceSha256: sha256.convert(<int>[1]).toString(),
      sourceBytes: 1,
      durationSeconds: 1,
      capability: 'asr.zh',
      maxSegments: 10,
    ),
  );
}
