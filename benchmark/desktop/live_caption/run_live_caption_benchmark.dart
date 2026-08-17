import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

const _expectedTarget = <String, Object?>{
  'modelIdentifier': 'Mac16,10',
  'os': 'macOS 15.7.5',
  'osBuild': '24G624',
  'architecture': 'arm64',
  'cpu': 'Apple M4',
  'logicalCpuCount': 10,
  'memoryBytes': 17179869184,
  'buildMode': 'debug',
};

Future<void> main(List<String> arguments) async {
  Process? worker;
  try {
    final options = _parse(arguments);
    final repositoryRoot = Directory(_required(options, 'repository-root'));
    final fixtureRoot = Directory(_required(options, 'fixture-root'));
    final contractFile = File(
      '${repositoryRoot.path}/benchmark/desktop/live_caption/'
      'sensevoice_live_caption_contract.json',
    );
    final manifestFile = File(
      '${repositoryRoot.path}/benchmark/desktop/live_caption/'
      'live_caption_fixtures.json',
    );
    final contract = (jsonDecode(await contractFile.readAsString()) as Map)
        .cast<String, Object?>();
    final manifest = (jsonDecode(await manifestFile.readAsString()) as Map)
        .cast<String, Object?>();
    await _validateHost();
    await _verify(
      manifestFile,
      ((contract['inputs']! as Map)['fixtureManifestSha256']! as String),
    );
    final modelRoot = Directory(_required(options, 'model-root'));
    final assetRoot = Directory(_required(options, 'asset-root'));
    final runtimeRoot = Directory(_required(options, 'runtime-root'));
    final workerExecutable = File(_required(options, 'worker-executable'));
    await _verify(
      workerExecutable,
      _required(options, 'worker-executable-sha256'),
    );
    final model = File('${modelRoot.path}/model.int8.onnx');
    final tokens = File('${modelRoot.path}/tokens.txt');
    final vad = File('${assetRoot.path}/silero_vad.onnx');
    await _verify(
      model,
      (((contract['model']! as Map)['files']! as Map)['model.int8.onnx']!
              as Map)['sha256']!
          as String,
    );
    await _verify(
      tokens,
      (((contract['model']! as Map)['files']! as Map)['tokens.txt']!
              as Map)['sha256']!
          as String,
    );
    await _verify(vad, (contract['vad']! as Map)['sha256']! as String);
    await _verifyRuntime(runtimeRoot, contract['runtime']! as Map);
    final workerPath =
        '${repositoryRoot.path}/packages/desktop_sherpa_worker/bin/'
        'desktop_sensevoice_caption_worker.dart';
    worker = await Process.start(
      workerExecutable.path,
      <String>[
        '--runtime-root=${runtimeRoot.path}',
        '--model-root=${modelRoot.path}',
        '--asset-root=${assetRoot.path}',
        '--fixture-root=${fixtureRoot.path}',
        '--model=${model.path}',
        '--tokens=${tokens.path}',
        '--vad=${vad.path}',
        '--model-sha256=${(((contract['model']! as Map)['files']! as Map)['model.int8.onnx']! as Map)['sha256']}',
        '--tokens-sha256=${(((contract['model']! as Map)['files']! as Map)['tokens.txt']! as Map)['sha256']}',
        '--vad-sha256=${(contract['vad']! as Map)['sha256']}',
        '--control-json=${jsonEncode(contract['control'])}',
      ],
      workingDirectory:
          '${repositoryRoot.path}/packages/desktop_sherpa_worker',
      environment: <String, String>{
        'PATH': Platform.environment['PATH'] ?? '/usr/bin:/bin',
        'LANG': 'en_US.UTF-8',
        'LC_ALL': 'en_US.UTF-8',
      },
    );
    final stderr = worker.stderr.transform(utf8.decoder).join();
    final iterator = StreamIterator<String>(
      worker.stdout.transform(utf8.decoder).transform(const LineSplitter()),
    );
    final ready = await _next(iterator, const Duration(minutes: 2));
    if (ready['type'] != 'ready' ||
        ready['publishesTokenPartials'] != false ||
        ready['effectiveConfig'] is! Map) {
      throw StateError('worker handshake is invalid');
    }
    final fixtureDocuments = (manifest['fixtures']! as List<Object?>)
        .cast<Map>()
        .map((value) => value.cast<String, Object?>())
        .where(
          (fixture) =>
              fixture['fixtureRole'] == 'held_out' ||
              fixture['fixtureRole'] == 'stability',
        )
        .toList(growable: false);
    final runs = <Map<String, Object?>>[];
    var sequence = 0;
    for (final fixture in fixtureDocuments) {
      sequence += 1;
      final audio = (fixture['audio']! as Map).cast<String, Object?>();
      final requestId = 'u13-$sequence';
      worker.stdin.writeln(
        jsonEncode(<String, Object?>{
          'schemaVersion': 1,
          'type': 'decode',
          'requestId': requestId,
          'fixtureId': fixture['fixtureId'],
          'sourcePath': '${fixtureRoot.path}/${audio['relativePath']}',
          'sourceSha256': audio['sha256'],
          'replayRealtime': fixture['fixtureRole'] == 'stability',
        }),
      );
      await worker.stdin.flush();
      final utterances = <Map<String, Object?>>[];
      Map<String, Object?>? complete;
      while (complete == null) {
        final event = await _next(iterator, const Duration(minutes: 20));
        if (event['type'] == 'error') {
          throw StateError('worker returned ${event['code']}');
        }
        if (event['requestId'] != requestId) {
          throw StateError('worker event request identity drifted');
        }
        if (event['type'] == 'utterance') {
          final receivedAtUs = DateTime.now().microsecondsSinceEpoch;
          final speechEndUs = event['speechEndEpochUs']! as int;
          utterances.add(<String, Object?>{
            ...event,
            'driverReceivedEpochUs': receivedAtUs,
            if (fixture['fixtureRole'] == 'stability')
              'speechEndToDriverVisibleMs': (receivedAtUs - speechEndUs) / 1000,
          });
        } else if (event['type'] == 'fixtureComplete') {
          complete = event;
        } else if (event['type'] != 'fixtureStart') {
          throw StateError('worker emitted an unknown event');
        }
      }
      final inputSamples = complete['inputSamples']! as int;
      final consumedSamples = complete['consumedSamples']! as int;
      if (inputSamples != consumedSamples) {
        throw StateError('worker did not consume the complete fixture');
      }
      runs.add(<String, Object?>{
        'fixtureId': fixture['fixtureId'],
        'fixtureRole': fixture['fixtureRole'],
        'scenario': fixture['scenario'],
        'audioSha256': audio['sha256'],
        'referenceSha256':
            ((fixture['reference']! as Map)['sha256']! as String),
        'audioDurationSeconds': audio['durationSeconds'],
        'utterances': utterances,
        'complete': complete,
      });
    }
    worker.stdin.writeln('{"type":"shutdown"}');
    await worker.stdin.flush();
    await worker.stdin.close();
    await iterator.cancel();
    final exit = await worker.exitCode.timeout(const Duration(seconds: 30));
    final errors = await stderr;
    if (exit != 0) throw StateError('worker exited $exit: $errors');
    final raw = <String, Object?>{
      'schemaVersion': 1,
      'kind': 'sensevoice_live_caption_raw',
      'contractId': contract['contractId'],
      'status': 'COMPLETE',
      'target': _expectedTarget,
      'bindings': <String, Object?>{
        'contractSha256': await _sha(contractFile),
        'fixtureManifestSha256': await _sha(manifestFile),
        'scorerSha256': (contract['inputs']! as Map)['scorerSha256'],
        'modelArchiveSha256': (contract['model']! as Map)['archiveSha256'],
        'modelSha256':
            (((contract['model']! as Map)['files']! as Map)['model.int8.onnx']!
                as Map)['sha256'],
        'tokensSha256':
            (((contract['model']! as Map)['files']! as Map)['tokens.txt']!
                as Map)['sha256'],
        'sileroVadSha256': (contract['vad']! as Map)['sha256'],
        'workerSha256': await _sha(File(workerPath)),
        'workerExecutableSha256': await _sha(workerExecutable),
      },
      'effectiveConfig': contract['control'],
      'ready': ready,
      'runs': runs,
      'visibilityMeasurement': 'driver_jsonl_receipt_not_flutter_frame',
      'captureControlMeasurement': 'NOT_MEASURED',
    };
    final output = File(_required(options, 'output'));
    await output.parent.create(recursive: true);
    await output.writeAsString(
      '${const JsonEncoder.withIndent('  ').convert(raw)}\n',
      flush: true,
    );
    stdout.writeln(
      jsonEncode(<String, Object?>{
        'status': 'COMPLETE',
        'runCount': runs.length,
        'output': output.path,
        'sha256': await _sha(output),
      }),
    );
  } catch (error, stackTrace) {
    stderr
      ..writeln(error)
      ..writeln(stackTrace);
    worker?.kill(ProcessSignal.sigkill);
    exitCode = 1;
  }
}

Future<Map<String, Object?>> _next(
  StreamIterator<String> iterator,
  Duration timeout,
) async {
  if (!await iterator.moveNext().timeout(timeout)) {
    throw StateError('worker closed before a complete event');
  }
  final line = iterator.current;
  if (utf8.encode(line).length > 1024 * 1024) {
    throw StateError('worker line exceeds one MiB');
  }
  final decoded = jsonDecode(line);
  if (decoded is! Map || decoded['schemaVersion'] != 1) {
    throw StateError('worker line has an invalid schema');
  }
  return decoded.cast<String, Object?>();
}

Future<void> _validateHost() async {
  Future<String> process(String executable, List<String> arguments) async {
    final result = await Process.run(executable, arguments);
    if (result.exitCode != 0) throw StateError('$executable failed');
    return (result.stdout as String).trim();
  }

  final observed = <String, Object?>{
    'modelIdentifier': await process('/usr/sbin/sysctl', <String>[
      '-n',
      'hw.model',
    ]),
    'os':
        'macOS ${await process('/usr/bin/sw_vers', <String>['-productVersion'])}',
    'osBuild': await process('/usr/bin/sw_vers', <String>['-buildVersion']),
    'architecture': await process('/usr/bin/uname', <String>['-m']),
    'cpu': await process('/usr/sbin/sysctl', <String>[
      '-n',
      'machdep.cpu.brand_string',
    ]),
    'logicalCpuCount': int.parse(
      await process('/usr/sbin/sysctl', <String>['-n', 'hw.logicalcpu']),
    ),
    'memoryBytes': int.parse(
      await process('/usr/sbin/sysctl', <String>['-n', 'hw.memsize']),
    ),
    'buildMode': 'debug',
  };
  if (jsonEncode(observed) != jsonEncode(_expectedTarget)) {
    throw StateError('benchmark target drifted: $observed');
  }
}

Future<void> _verifyRuntime(
  Directory root,
  Map<Object?, Object?> runtime,
) async {
  final libraries = (runtime['libraries']! as Map).cast<String, Object?>();
  for (final entry in libraries.entries) {
    await _verify(File('${root.path}/${entry.key}'), entry.value! as String);
  }
}

Future<void> _verify(File file, String expected) async {
  if (!await file.exists() || await _sha(file) != expected) {
    throw StateError('asset hash drifted: ${file.path}');
  }
}

Future<String> _sha(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();

Map<String, String> _parse(List<String> arguments) {
  final values = <String, String>{};
  for (final argument in arguments) {
    if (!argument.startsWith('--') || !argument.contains('=')) {
      throw const FormatException('arguments must be --key=value');
    }
    final separator = argument.indexOf('=');
    final key = argument.substring(2, separator);
    final value = argument.substring(separator + 1);
    if (key.isEmpty || value.isEmpty || values.containsKey(key)) {
      throw const FormatException('invalid or duplicate argument');
    }
    values[key] = value;
  }
  return values;
}

String _required(Map<String, String> values, String key) {
  final value = values[key];
  if (value == null || value.isEmpty) throw FormatException('missing --$key');
  return value;
}
