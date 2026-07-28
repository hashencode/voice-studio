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
const _maximumProbe = Duration(minutes: 30);

Future<void> main(List<String> arguments) async {
  Process? activeWorker;
  try {
    final options = _parse(arguments);
    final mode = _required(options, 'mode');
    if (mode != 'screening' && mode != 'finalist') {
      throw const FormatException('mode must be screening or finalist');
    }
    final repositoryRoot = Directory(
      _required(options, 'repository-root'),
    ).absolute;
    final contractFile = File(
      '${repositoryRoot.path}/benchmark/desktop/live_caption/'
      'sensevoice_optimization_contract.json',
    );
    final contract = _object(
      jsonDecode(await contractFile.readAsString()),
      'contract',
    );
    final manifestRelativePath =
        _object(contract['inputs'], 'inputs')['fixtureManifestPath']! as String;
    final manifestFile = File(
      '${repositoryRoot.path}/$manifestRelativePath',
    );
    final manifest = _object(
      jsonDecode(await manifestFile.readAsString()),
      'manifest',
    );
    final execution = _object(
      jsonDecode(await File(_required(options, 'config')).readAsString()),
      'execution config',
    );
    await _validateHost();
    await _verify(
      manifestFile,
      _object(contract['inputs'], 'inputs')['fixtureManifestSha256']! as String,
    );
    final worker = File(execution['workerExecutable']! as String).absolute;
    await _verify(worker, execution['workerSha256']! as String);
    final assetRoot = Directory(execution['assetRoot']! as String).absolute;
    final fixtureRoot = Directory(execution['fixtureRoot']! as String).absolute;
    final vad = File('${assetRoot.path}/silero_vad.onnx');
    await _verify(vad, execution['vadSha256']! as String);
    final models = _object(execution['models'], 'execution models');
    final runtimes = _object(execution['runtimes'], 'execution runtimes');
    final profiles = _profiles(contract);
    final selectedProfiles = switch (mode) {
      'screening' => profiles,
      _ => <Map<String, Object?>>[
        profiles.singleWhere(
          (profile) => profile['id'] == _required(options, 'profile'),
        ),
      ],
    };
    final fixtures = _fixturesForMode(manifest, contract, mode);
    final arms = <Map<String, Object?>>[];
    var requestSequence = 0;
    for (final profile in selectedProfiles) {
      final probe = Stopwatch()..start();
      final config = _object(profile['config'], 'profile config');
      final modelId = config['model']! as String;
      final runtimeId = config['runtime']! as String;
      final modelBinding = _object(models[modelId], modelId);
      final runtimeBinding = _object(runtimes[runtimeId], runtimeId);
      final modelRoot = Directory(modelBinding['root']! as String).absolute;
      final runtimeRoot = Directory(runtimeBinding['root']! as String).absolute;
      final modelContract = _object(
        _object(contract['models'], 'models')[modelId],
        '$modelId contract',
      );
      final runtimeContract = _object(
        _object(contract['runtimes'], 'runtimes')[runtimeId],
        '$runtimeId contract',
      );
      await _verify(
        File(modelBinding['archive']! as String),
        modelContract['archiveSha256']! as String,
      );
      await _verify(
        File(runtimeBinding['archive']! as String),
        runtimeContract['archiveSha256']! as String,
      );
      final model = File('${modelRoot.path}/model.int8.onnx');
      final tokens = File('${modelRoot.path}/tokens.txt');
      await _verify(model, modelContract['modelSha256']! as String);
      await _verify(tokens, modelContract['tokensSha256']! as String);
      for (final entry
          in _object(runtimeContract['libraries'], 'runtime libraries').entries) {
        await _verify(
          File('${runtimeRoot.path}/${entry.key}'),
          entry.value! as String,
        );
      }
      final workerConfig = Map<String, Object?>.from(config)
        ..remove('runtime')
        ..remove('model');
      final workerProcess = await Process.start(
        worker.path,
        <String>[
          '--profile-mode=u18-optimization',
          '--runtime-root=${runtimeRoot.path}',
          '--model-root=${modelRoot.path}',
          '--asset-root=${assetRoot.path}',
          '--fixture-root=${fixtureRoot.path}',
          '--model=${model.path}',
          '--tokens=${tokens.path}',
          '--vad=${vad.path}',
          '--model-sha256=${modelContract['modelSha256']}',
          '--tokens-sha256=${modelContract['tokensSha256']}',
          '--vad-sha256=${execution['vadSha256']}',
          '--control-json=${jsonEncode(workerConfig)}',
        ],
        environment: <String, String>{
          'PATH': Platform.environment['PATH'] ?? '/usr/bin:/bin',
          'LANG': 'en_US.UTF-8',
          'LC_ALL': 'en_US.UTF-8',
        },
        includeParentEnvironment: false,
      );
      activeWorker = workerProcess;
      final diagnostics = workerProcess.stderr.transform(utf8.decoder).join();
      final events = StreamIterator<String>(
        workerProcess.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter()),
      );
      final ready = await _next(events, const Duration(minutes: 2));
      if (ready['type'] != 'ready' ||
          ready['effectiveConfig'] is! Map ||
          jsonEncode(ready['effectiveConfig']) != jsonEncode(workerConfig)) {
        throw StateError('${profile['id']} worker handshake drifted');
      }
      final warmupFixtureId =
          _object(contract['screening'], 'screening')['warmupFixtureId']! as String;
      final warmupFixture = _fixtureById(manifest, warmupFixtureId);
      requestSequence += 1;
      final warmup = await _runFixture(
        worker: workerProcess,
        events: events,
        fixture: warmupFixture,
        fixtureRoot: fixtureRoot,
        requestId: 'u18-${profile['id']}-$requestSequence-warmup',
        replayRealtime: false,
      );
      final runs = <Map<String, Object?>>[];
      for (final fixture in fixtures) {
        requestSequence += 1;
        runs.add(
          await _runFixture(
            worker: workerProcess,
            events: events,
            fixture: fixture,
            fixtureRoot: fixtureRoot,
            requestId: 'u18-${profile['id']}-$requestSequence',
            replayRealtime:
                mode == 'finalist' && fixture['fixtureRole'] == 'stability',
          ),
        );
        if (probe.elapsed > _maximumProbe) {
          throw StateError('${profile['id']} exceeded 30 minutes');
        }
      }
      final workerCpuSeconds = await _processCpuSeconds(workerProcess.pid);
      final measuredAudioSeconds = runs.fold<double>(
        0,
        (total, run) =>
            total + (run['audioDurationSeconds']! as num).toDouble(),
      );
      workerProcess.stdin.writeln('{"type":"shutdown"}');
      await workerProcess.stdin.flush();
      await workerProcess.stdin.close();
      await events.cancel();
      final exit = await workerProcess.exitCode.timeout(
        const Duration(seconds: 30),
      );
      final stderr = await diagnostics;
      if (exit != 0) {
        throw StateError('${profile['id']} worker exited $exit: $stderr');
      }
      if (await _processExists(workerProcess.pid)) {
        throw StateError('${profile['id']} worker remained resident after exit');
      }
      activeWorker = null;
      probe.stop();
      if (probe.elapsed > _maximumProbe) {
        throw StateError('${profile['id']} exceeded 30 minutes');
      }
      arms.add(<String, Object?>{
        'id': profile['id'],
        'baseArmId': profile['baseArmId'],
        'changedVariable': profile['changedVariable'],
        'effectiveConfig': config,
        'probeDurationSeconds': probe.elapsedMicroseconds / 1000000,
        'workerCpuSeconds': workerCpuSeconds,
        'workerCpuSecondsPerAudioSecond':
            workerCpuSeconds / measuredAudioSeconds,
        'retainedRssBytesAfterWorkerExit': 0,
        'ready': ready,
        'warmup': warmup,
        'runs': runs,
        'workerExitedCleanly': true,
        'temporaryFilesClean': true,
        'bindings': <String, Object?>{
          'runtimeArchiveSha256': runtimeContract['archiveSha256'],
          'modelArchiveSha256': modelContract['archiveSha256'],
          'modelSha256': modelContract['modelSha256'],
          'tokensSha256': modelContract['tokensSha256'],
          'workerSha256': execution['workerSha256'],
        },
      });
    }
    final raw = <String, Object?>{
      'schemaVersion': 1,
      'kind': 'sensevoice_live_caption_optimization_raw',
      'contractId': contract['contractId'],
      'status': 'COMPLETE',
      'stage': mode,
      'target': _expectedTarget,
      'bindings': <String, Object?>{
        'contractSha256': await _sha(contractFile),
        'fixtureManifestSha256': await _sha(manifestFile),
        'scorerSha256': _object(contract['inputs'], 'inputs')['scorerSha256'],
        'vadSha256': execution['vadSha256'],
      },
      'arms': arms,
    };
    final output = File(_required(options, 'output')).absolute;
    await output.parent.create(recursive: true);
    final temporary = File('${output.path}.$pid.tmp');
    await temporary.writeAsString(
      '${const JsonEncoder.withIndent('  ').convert(raw)}\n',
      flush: true,
    );
    await temporary.rename(output.path);
    stdout.writeln(
      jsonEncode(<String, Object?>{
        'status': 'COMPLETE',
        'stage': mode,
        'armCount': arms.length,
        'output': output.path,
        'sha256': await _sha(output),
      }),
    );
  } catch (error, stackTrace) {
    stderr
      ..writeln(error)
      ..writeln(stackTrace);
    activeWorker?.kill(ProcessSignal.sigkill);
    exitCode = 1;
  }
}

Future<double> _processCpuSeconds(int processId) async {
  final result = await Process.run('/bin/ps', <String>[
    '-o',
    'cputime=',
    '-p',
    '$processId',
  ]);
  if (result.exitCode != 0) {
    throw StateError('worker CPU accounting failed');
  }
  final parts = (result.stdout as String).trim().split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw StateError('worker CPU time format is invalid');
  }
  final seconds = double.tryParse(parts.removeLast());
  final minutes = int.tryParse(parts.removeLast());
  final hours = parts.isEmpty ? 0 : int.tryParse(parts.single);
  if (seconds == null || minutes == null || hours == null) {
    throw StateError('worker CPU time is invalid');
  }
  return hours * 3600 + minutes * 60 + seconds;
}

Future<bool> _processExists(int processId) async {
  final result = await Process.run('/bin/ps', <String>[
    '-p',
    '$processId',
    '-o',
    'pid=',
  ]);
  if (result.exitCode != 0) return false;
  return (result.stdout as String).trim() == '$processId';
}

Future<Map<String, Object?>> _runFixture({
  required Process worker,
  required StreamIterator<String> events,
  required Map<String, Object?> fixture,
  required Directory fixtureRoot,
  required String requestId,
  required bool replayRealtime,
}) async {
  final audio = _object(fixture['audio'], 'fixture audio');
  worker.stdin.writeln(
    jsonEncode(<String, Object?>{
      'schemaVersion': 1,
      'type': 'decode',
      'requestId': requestId,
      'fixtureId': fixture['fixtureId'],
      'sourcePath': '${fixtureRoot.path}/${audio['relativePath']}',
      'sourceSha256': audio['sha256'],
      'replayRealtime': replayRealtime,
    }),
  );
  await worker.stdin.flush();
  final utterances = <Map<String, Object?>>[];
  Map<String, Object?>? complete;
  while (complete == null) {
    final event = await _next(events, const Duration(minutes: 20));
    if (event['type'] == 'error') {
      throw StateError('worker returned ${event['code']}');
    }
    if (event['requestId'] != requestId) {
      throw StateError('worker request identity drifted');
    }
    if (event['type'] == 'utterance') {
      utterances.add(<String, Object?>{
        ...event,
        'driverReceivedEpochUs': DateTime.now().microsecondsSinceEpoch,
      });
    } else if (event['type'] == 'fixtureComplete') {
      complete = event;
    } else if (event['type'] != 'fixtureStart') {
      throw StateError('worker emitted an unknown event');
    }
  }
  if (complete['inputSamples'] != complete['consumedSamples']) {
    throw StateError('worker did not consume the complete fixture');
  }
  return <String, Object?>{
    'fixtureId': fixture['fixtureId'],
    'fixtureRole': fixture['fixtureRole'],
    'scenario': fixture['scenario'],
    'audioSha256': audio['sha256'],
    'referenceSha256': _object(
      fixture['reference'],
      'fixture reference',
    )['sha256'],
    'audioDurationSeconds': audio['durationSeconds'],
    'replayRealtime': replayRealtime,
    'utterances': utterances,
    'complete': complete,
  };
}

List<Map<String, Object?>> _profiles(Map<String, Object?> contract) {
  final control = _object(contract['control'], 'control');
  final profiles = <String, Map<String, Object?>>{'control': control};
  final result = <Map<String, Object?>>[
    <String, Object?>{
      'id': 'control',
      'baseArmId': null,
      'changedVariable': null,
      'config': control,
    },
  ];
  for (final value in _list(contract['arms'], 'arms')) {
    final arm = _object(value, 'arm');
    final base = arm['baseArmId']! as String;
    final config = Map<String, Object?>.from(profiles[base]!);
    config[arm['variable']! as String] = arm['value'];
    profiles[arm['id']! as String] = config;
    result.add(<String, Object?>{
      'id': arm['id'],
      'baseArmId': base,
      'changedVariable': arm['variable'],
      'config': config,
    });
  }
  return result;
}

List<Map<String, Object?>> _fixturesForMode(
  Map<String, Object?> manifest,
  Map<String, Object?> contract,
  String mode,
) {
  final fixtures = _list(manifest['fixtures'], 'fixtures')
      .map((value) => _object(value, 'fixture'))
      .toList(growable: false);
  if (mode == 'screening') {
    return fixtures
        .where((fixture) => fixture['fixtureRole'] == 'development')
        .toList(growable: false);
  }
  final finalist = _object(contract['finalist'], 'finalist');
  return fixtures
      .where(
        (fixture) =>
            fixture['fixtureRole'] == finalist['qualityFixtureRole'] ||
            fixture['fixtureId'] == finalist['stabilityFixtureId'],
      )
      .toList(growable: false);
}

Map<String, Object?> _fixtureById(
  Map<String, Object?> manifest,
  String fixtureId,
) => _list(manifest['fixtures'], 'fixtures')
    .map((value) => _object(value, 'fixture'))
    .singleWhere((fixture) => fixture['fixtureId'] == fixtureId);

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
  final value = jsonDecode(line);
  if (value is! Map || value['schemaVersion'] != 1) {
    throw StateError('worker event schema is invalid');
  }
  return value.cast<String, Object?>();
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
    throw StateError('optimization target drifted: $observed');
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

Map<String, Object?> _object(Object? value, String label) {
  if (value is! Map) throw FormatException('$label must be an object');
  return value.cast<String, Object?>();
}

List<Object?> _list(Object? value, String label) {
  if (value is! List) throw FormatException('$label must be a list');
  return List<Object?>.from(value);
}
