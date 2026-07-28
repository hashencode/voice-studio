import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:ui' show FrameTiming;

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';

const _probeDuration = Duration(minutes: 1);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'SenseVoice visibility and concurrent capture accounting are measured',
    (tester) async {
      final environment = Platform.environment;
      final contractFile = File(
        _required(environment, 'VOICE2TEXT_U13_CONTRACT'),
      );
      final manifestFile = File(
        _required(environment, 'VOICE2TEXT_U13_FIXTURE_MANIFEST'),
      );
      final contract = (jsonDecode(await contractFile.readAsString()) as Map)
          .cast<String, Object?>();
      final manifest = (jsonDecode(await manifestFile.readAsString()) as Map)
          .cast<String, Object?>();
      final fixture = (manifest['fixtures']! as List<Object?>)
          .cast<Map>()
          .map((value) => value.cast<String, Object?>())
          .singleWhere((value) => value['fixtureRole'] == 'stability');
      final audio = (fixture['audio']! as Map).cast<String, Object?>();
      final fixtureRoot = Directory(
        _required(environment, 'VOICE2TEXT_U13_FIXTURE_ROOT'),
      );
      final audioFile = File(
        p.join(fixtureRoot.path, audio['relativePath']! as String),
      );
      expect(await _sha(audioFile), audio['sha256']);

      final caption = ValueNotifier<String>('等待实时草稿');
      addTearDown(caption.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: ValueListenableBuilder<String>(
                valueListenable: caption,
                builder: (context, value, child) => Text(
                  value,
                  key: const ValueKey<String>('live-caption-probe'),
                ),
              ),
            ),
          ),
        ),
      );

      final frameTimings = <FrameTiming>[];
      void collectTimings(List<FrameTiming> timings) {
        frameTimings.addAll(timings);
      }

      binding.addTimingsCallback(collectTimings);
      addTearDown(() => binding.removeTimingsCallback(collectTimings));

      final support = await getApplicationSupportDirectory();
      final runId = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
      final runRoot = Directory(
        p.join(support.path, 'u13-live-caption-control-probe', runId),
      );
      final capture = MacosDesktopCapturePort();
      final control = await _runCapture(
        tester: tester,
        capture: capture,
        root: Directory(p.join(runRoot.path, 'control')),
        suffix: 'control-$runId',
        audioFile: audioFile,
        duration: _probeDuration,
      );

      frameTimings.clear();
      final concurrentRoot = Directory(p.join(runRoot.path, 'concurrent'));
      final concurrentSession = 'session-caption-$runId';
      final preflight = await capture.preflight(
        sessionRoot: concurrentRoot.path,
        minimumFreeBytes: 128 * 1024 * 1024,
        captionModelAvailable: true,
      );
      expect(
        preflight.canStart,
        isTrue,
        reason: 'Capture preflight blocked: ${preflight.blockingReasons}',
      );
      await capture.start(
        DesktopCaptureStartRequest(
          sessionId: concurrentSession,
          sessionRoot: concurrentRoot.path,
          idempotencyKey: 'start-$concurrentSession',
          minimumFreeBytes: 128 * 1024 * 1024,
          captionEnabled: true,
        ),
      );
      final player = await Process.start('/usr/bin/afplay', <String>[
        audioFile.path,
      ]);
      final worker = await _startWorker(
        environment: environment,
        fixtureRoot: fixtureRoot,
        contract: contract,
      );
      addTearDown(() {
        player.kill();
        worker.process.kill(ProcessSignal.sigkill);
      });

      final ready = await worker.next(const Duration(minutes: 2));
      expect(ready['type'], 'ready');
      var maximumFlutterAppRssBytes = ProcessInfo.currentRss;
      var maximumWorkerRssBytes = ready['residentBytes']! as int;
      worker.process.stdin.writeln(
        jsonEncode(<String, Object?>{
          'schemaVersion': 1,
          'type': 'decode',
          'requestId': 'u13-flutter-frame',
          'fixtureId': fixture['fixtureId'],
          'sourcePath': audioFile.path,
          'sourceSha256': audio['sha256'],
          'replayRealtime': true,
        }),
      );
      await worker.process.stdin.flush();

      final resultToVisibleMs = <double>[];
      final speechEndToVisibleMs = <double>[];
      final deadline = DateTime.now().add(_probeDuration);
      while (DateTime.now().isBefore(deadline)) {
        Map<String, Object?> event;
        try {
          event = await worker.next(deadline.difference(DateTime.now()));
        } on TimeoutException {
          break;
        }
        if (event['type'] == 'error') {
          fail('SenseVoice worker failed: ${event['code']}');
        }
        maximumFlutterAppRssBytes = max(
          maximumFlutterAppRssBytes,
          ProcessInfo.currentRss,
        );
        if (event['residentBytes'] case final int residentBytes) {
          maximumWorkerRssBytes = max(maximumWorkerRssBytes, residentBytes);
        }
        if (event['type'] != 'utterance') {
          continue;
        }
        final receivedAtUs = DateTime.now().microsecondsSinceEpoch;
        caption.value = event['text']! as String;
        await tester.pump();
        expect(
          find.byKey(const ValueKey<String>('live-caption-probe')),
          findsOneWidget,
        );
        final visibleAtUs = DateTime.now().microsecondsSinceEpoch;
        resultToVisibleMs.add((visibleAtUs - receivedAtUs) / 1000);
        speechEndToVisibleMs.add(
          (visibleAtUs - (event['speechEndEpochUs']! as int)) / 1000,
        );
      }
      expect(resultToVisibleMs, isNotEmpty);

      player.kill();
      worker.process.kill(ProcessSignal.sigterm);
      await worker.dispose();
      final stopped = await capture.stop(
        sessionId: concurrentSession,
        idempotencyKey: 'stop-$concurrentSession',
      );
      expect(stopped.state, DesktopCaptureSessionState.completed);
      final concurrent = await _frameAccounting(concurrentSession);
      _expectZeroLoss(control);
      _expectZeroLoss(concurrent);

      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final longFrames = frameTimings
          .where(
            (timing) =>
                timing.totalSpan.inMicroseconds >
                const Duration(milliseconds: 16).inMicroseconds,
          )
          .length;
      final output = File(
        _required(environment, 'VOICE2TEXT_U13_PROBE_OUTPUT'),
      );
      await output.parent.create(recursive: true);
      final evidence = <String, Object?>{
        'schemaVersion': 1,
        'kind': 'sensevoice_live_caption_flutter_capture_probe',
        'status': 'COMPLETE',
        'target': contract['target'],
        'bindings': <String, Object?>{
          'contractSha256': await _sha(contractFile),
          'fixtureManifestSha256': await _sha(manifestFile),
          'fixtureAudioSha256': audio['sha256'],
          'workerExecutableSha256': await _sha(
            File(_required(environment, 'VOICE2TEXT_U13_WORKER_EXECUTABLE')),
          ),
        },
        'durationSeconds': _probeDuration.inSeconds * 2,
        'controlDurationSeconds': _probeDuration.inSeconds,
        'concurrentDurationSeconds': _probeDuration.inSeconds,
        'visibilityMeasurement': 'flutter_frame_timing',
        'flutterVisibility': <String, Object?>{
          'resultToVisibleMs': resultToVisibleMs,
          'speechEndToVisibleMs': speechEndToVisibleMs,
          'sampleCount': resultToVisibleMs.length,
        },
        'uiFrames': <String, Object?>{
          'sampleCount': frameTimings.length,
          'longFrameCount': longFrames,
          'longFrameRate': frameTimings.isEmpty
              ? 0.0
              : longFrames / frameTimings.length,
        },
        'resourceSampling': <String, Object?>{
          'maximumFlutterAppRssBytes': maximumFlutterAppRssBytes,
          'maximumWorkerRssBytes': maximumWorkerRssBytes,
          'conservativeMaximumCombinedRssBytes':
              maximumFlutterAppRssBytes + maximumWorkerRssBytes,
        },
        'captureControlMeasurement': 'concurrent_native_capture',
        'captureAccounting': <String, Object?>{
          'control': control,
          'concurrent': concurrent,
        },
      };
      await output.writeAsString(
        '${const JsonEncoder.withIndent('  ').convert(evidence)}\n',
        flush: true,
      );
      stdout.writeln(
        jsonEncode(<String, Object?>{
          'status': 'COMPLETE',
          'output': output.path,
          'sha256': await _sha(output),
        }),
      );
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
}

Future<Map<Object?, Object?>> _runCapture({
  required WidgetTester tester,
  required MacosDesktopCapturePort capture,
  required Directory root,
  required String suffix,
  required File audioFile,
  required Duration duration,
}) async {
  final sessionId = 'session-$suffix';
  final preflight = await capture.preflight(
    sessionRoot: root.path,
    minimumFreeBytes: 128 * 1024 * 1024,
    captionModelAvailable: false,
  );
  expect(
    preflight.canStart,
    isTrue,
    reason: 'Capture preflight blocked: ${preflight.blockingReasons}',
  );
  await capture.start(
    DesktopCaptureStartRequest(
      sessionId: sessionId,
      sessionRoot: root.path,
      idempotencyKey: 'start-$sessionId',
      minimumFreeBytes: 128 * 1024 * 1024,
    ),
  );
  final player = await Process.start('/usr/bin/afplay', <String>[
    audioFile.path,
  ]);
  final deadline = DateTime.now().add(duration);
  while (DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(seconds: 1));
    await tester.pump();
  }
  player.kill();
  final stopped = await capture.stop(
    sessionId: sessionId,
    idempotencyKey: 'stop-$sessionId',
  );
  expect(stopped.state, DesktopCaptureSessionState.completed);
  return _frameAccounting(sessionId);
}

Future<Map<Object?, Object?>> _frameAccounting(String sessionId) async {
  const channel = MethodChannel('com.voice2text.desktop/capture');
  final value = await channel.invokeMapMethod<Object?, Object?>(
    'developmentFrameAccounting',
    <String, Object?>{'sessionId': sessionId},
  );
  return value!;
}

void _expectZeroLoss(Map<Object?, Object?> accounting) {
  for (final track in <String>['systemAudio', 'microphone']) {
    final values = (accounting[track]! as Map).cast<Object?, Object?>();
    expect(values['deliveredFrames'], greaterThan(0), reason: track);
    expect(values['committedFrames'], values['deliveredFrames'], reason: track);
    expect(values['lostFrames'], 0, reason: track);
  }
}

Future<_Worker> _startWorker({
  required Map<String, String> environment,
  required Directory fixtureRoot,
  required Map<String, Object?> contract,
}) async {
  final modelRoot = Directory(
    _required(environment, 'VOICE2TEXT_U13_MODEL_ROOT'),
  );
  final assetRoot = Directory(
    _required(environment, 'VOICE2TEXT_U13_ASSET_ROOT'),
  );
  final worker = await Process.start(
    _required(environment, 'VOICE2TEXT_U13_WORKER_EXECUTABLE'),
    <String>[
      '--runtime-root=${_required(environment, 'VOICE2TEXT_U13_RUNTIME_ROOT')}',
      '--model-root=${modelRoot.path}',
      '--asset-root=${assetRoot.path}',
      '--fixture-root=${fixtureRoot.path}',
      '--model=${p.join(modelRoot.path, 'model.int8.onnx')}',
      '--tokens=${p.join(modelRoot.path, 'tokens.txt')}',
      '--vad=${p.join(assetRoot.path, 'silero_vad.onnx')}',
      '--model-sha256=${(((contract['model']! as Map)['files']! as Map)['model.int8.onnx']! as Map)['sha256']}',
      '--tokens-sha256=${(((contract['model']! as Map)['files']! as Map)['tokens.txt']! as Map)['sha256']}',
      '--vad-sha256=${(contract['vad']! as Map)['sha256']}',
      '--control-json=${jsonEncode(contract['control'])}',
    ],
    workingDirectory: fixtureRoot.path,
  );
  return _Worker(worker);
}

class _Worker {
  _Worker(this.process)
    : _iterator = StreamIterator<String>(
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      ),
      _stderr = process.stderr.transform(utf8.decoder).join();

  final Process process;
  final StreamIterator<String> _iterator;
  final Future<String> _stderr;

  Future<Map<String, Object?>> next(Duration timeout) async {
    if (!await _iterator.moveNext().timeout(timeout)) {
      throw StateError('SenseVoice worker closed: ${await _stderr}');
    }
    final value = jsonDecode(_iterator.current);
    if (value is! Map || value['schemaVersion'] != 1) {
      throw const FormatException('SenseVoice worker event is invalid');
    }
    return value.cast<String, Object?>();
  }

  Future<void> dispose() async {
    await _iterator.cancel();
    await process.exitCode.timeout(
      const Duration(seconds: 10),
      onTimeout: () {
        process.kill(ProcessSignal.sigkill);
        return process.exitCode;
      },
    );
    await _stderr;
  }
}

String _required(Map<String, String> environment, String key) {
  final value = environment[key];
  if (value == null || value.isEmpty) {
    throw StateError('Missing environment variable: $key');
  }
  return value;
}

Future<String> _sha(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();
