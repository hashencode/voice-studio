import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

const _defaultContractPath =
    'benchmark/desktop/asr_comparison/qwen3_optimization_contract.json';

Future<void> main(List<String> arguments) async {
  final options = _Options.parse(arguments);
  final contractFile = File(options.contractPath);
  final contract = _object(
    jsonDecode(await contractFile.readAsString()),
    'contract',
  );
  _validateContractEnvelope(contract);

  final root = Directory.current.absolute;
  final inputs = _object(contract['inputs'], 'contract.inputs');
  final missingInputs = <String>[];
  final fixtures = await _validateQualityPack(
    root: root,
    audioRoot: options.audioRoot,
    inputs: inputs,
    missingInputs: missingInputs,
  );
  await _validateExecutionAssets(
    contract: contract,
    options: options,
    missingInputs: missingInputs,
  );

  final result = <String, Object?>{
    'schemaVersion': 2,
    'contractId': contract['contractId'],
    'status': missingInputs.isEmpty ? 'READY' : 'BLOCKED',
    'target': contract['target'],
    'fixtureManifestSha256': inputs['fixtureManifestSha256'],
    'scoringContractSha256': inputs['scoringContractSha256'],
    'requestedArm': options.arm ?? 'all',
    'registeredArms': <String>[
      'control',
      for (final arm in _list(contract['arms'], 'contract.arms'))
        _object(arm, 'contract.arm')['id']! as String,
    ],
    'verifiedFixtures': fixtures,
    'missingInputs': missingInputs..sort(),
    'maximumProbeMinutes': contract['maximumProbeMinutes'],
    'executionRequested': options.execute,
    'executionReady': missingInputs.isEmpty,
  };

  if (options.outputPath case final outputPath?
      when !options.execute || missingInputs.isNotEmpty) {
    await _atomicJson(File(outputPath), result);
  }
  stdout.writeln(jsonEncode(result));

  if (options.execute && missingInputs.isNotEmpty) {
    exitCode = 2;
    return;
  }
  if (options.execute) {
    await _executePhysicalDriver(options);
  }
}

Future<void> _executePhysicalDriver(_Options options) async {
  final outputPath = options.outputPath;
  if (outputPath == null) {
    throw const FormatException('--execute requires --output');
  }
  final config = <String, Object?>{
    'buildMode': 'debug',
    'audioRoot': Directory(options.audioRoot!).absolute.path,
    'modelRoot': Directory(options.modelRoot!).absolute.path,
    'sileroVad': File(options.sileroVadPath!).absolute.path,
    'runtimeLanes': <String, Object?>{
      'sherpa-onnx-1.13.4-ort-1.27.0': <String, Object?>{
        'root': Directory(options.runtimeRoot!).absolute.path,
        'archive': File(options.runtimeArchivePath!).absolute.path,
      },
      'sherpa-onnx-1.13.4-ort-1.24.4': <String, Object?>{
        'root': Directory(options.ort1244RuntimeRoot!).absolute.path,
        'archive': File(options.ort1244RuntimeArchivePath!).absolute.path,
      },
    },
    'sandboxLauncher': File(options.sandboxLauncherPath!).absolute.path,
    'nativeProcessGroupLauncher': File(
      options.nativeLauncherPath!,
    ).absolute.path,
    'worker': File(options.workerPath!).absolute.path,
    'jobRoot': Directory(options.jobRoot!).absolute.path,
    'output': File(outputPath).absolute.path,
  };
  final temporary = File(
    '${File(outputPath).absolute.path}.$pid.execution-config.tmp.json',
  );
  await temporary.writeAsString(jsonEncode(config));
  try {
    final process = await Process.start(
      options.pythonPath,
      <String>[
        'benchmark/desktop/asr_comparison/qwen3_optimization_driver.py',
        '--config',
        temporary.path,
        '--contract',
        options.contractPath,
      ],
      workingDirectory: Directory.current.path,
      mode: ProcessStartMode.normal,
    );
    await Future.wait(<Future<void>>[
      stdout.addStream(process.stdout),
      stderr.addStream(process.stderr),
    ]);
    final code = await process.exitCode;
    if (code != 0) {
      throw StateError('Qwen3 physical optimization driver failed: $code');
    }
  } finally {
    if (await temporary.exists()) await temporary.delete();
  }
}

void _validateContractEnvelope(Map<String, Object?> contract) {
  if (contract['schemaVersion'] != 2 ||
      contract['developmentPosture'] != 'DEVELOPMENT_ONLY' ||
      contract['maximumProbeMinutes'] != 30) {
    throw StateError('Qwen3 optimization contract is not bounded');
  }
  final arms = _list(
    contract['arms'],
    'contract.arms',
  ).map((value) => _object(value, 'contract.arm')).toList(growable: false);
  final seen = <String>{'control'};
  for (final arm in arms) {
    final id = arm['id'];
    final base = arm['baseArmId'];
    if (id is! String ||
        id.isEmpty ||
        seen.contains(id) ||
        base is! String ||
        !seen.contains(base)) {
      throw const FormatException('Qwen3 arm dependency is invalid');
    }
    seen.add(id);
  }
}

Future<List<Map<String, Object?>>> _validateQualityPack({
  required Directory root,
  required String? audioRoot,
  required Map<String, Object?> inputs,
  required List<String> missingInputs,
}) async {
  final manifest = await _readPinnedJson(
    root: root,
    relativePath: inputs['fixtureManifestPath'],
    expectedSha256: inputs['fixtureManifestSha256'],
    label: 'fixture-manifest',
  );
  await _readPinnedJson(
    root: root,
    relativePath: inputs['scoringContractPath'],
    expectedSha256: inputs['scoringContractSha256'],
    label: 'scoring-contract',
  );
  final requiredScenarios = _list(
    inputs['requiredScenarios'],
    'contract.inputs.requiredScenarios',
  ).cast<String>();
  final manifestFixtures = _list(
    manifest['fixtures'],
    'fixtureManifest.fixtures',
  ).map((value) => _object(value, 'fixture')).toList(growable: false);
  final verified = <Map<String, Object?>>[];
  for (final scenario in requiredScenarios) {
    final candidates = manifestFixtures.where(
      (fixture) =>
          fixture['scenario'] == scenario &&
          fixture['fixtureRole'] == 'held_out' &&
          fixture['freezeState'] == 'FROZEN',
    );
    if (candidates.length != 1) {
      missingInputs.add('quality-pack:$scenario:frozen-held-out-fixture');
      continue;
    }
    final fixture = candidates.single;
    if (audioRoot == null) {
      missingInputs.add('quality-pack:$scenario:audio-root');
      continue;
    }
    final audio = _object(fixture['audio'], 'fixture.audio');
    final reference = _object(fixture['reference'], 'fixture.reference');
    final audioIdentity = await _verifyPackFile(
      Directory(audioRoot),
      audio,
      '$scenario:audio',
      missingInputs,
    );
    final referenceIdentity = await _verifyPackFile(
      Directory(audioRoot),
      reference,
      '$scenario:reference',
      missingInputs,
    );
    if (audioIdentity && referenceIdentity) {
      verified.add(<String, Object?>{
        'fixtureId': fixture['fixtureId'],
        'scenario': scenario,
        'audioSha256': audio['sha256'],
        'referenceSha256': reference['sha256'],
      });
    }
  }
  return verified;
}

Future<void> _validateExecutionAssets({
  required Map<String, Object?> contract,
  required _Options options,
  required List<String> missingInputs,
}) async {
  if (!options.execute) return;
  if (options.modelRoot == null) {
    missingInputs.add('model-root');
  } else {
    final model = _object(contract['model'], 'contract.model');
    final hashes = _object(model['hashes'], 'contract.model.hashes');
    final root = Directory(options.modelRoot!);
    await _verifyFile(
      File('${root.path}/conv_frontend.onnx'),
      hashes['convFrontend'],
      'model:convFrontend',
      missingInputs,
    );
    await _verifyFile(
      File('${root.path}/encoder.int8.onnx'),
      hashes['encoder'],
      'model:encoder',
      missingInputs,
    );
    await _verifyFile(
      File('${root.path}/decoder.int8.onnx'),
      hashes['decoder'],
      'model:decoder',
      missingInputs,
    );
    await _verifyDirectory(
      Directory('${root.path}/tokenizer'),
      hashes['tokenizerTree'],
      'model:tokenizer',
      missingInputs,
    );
    if (options.sileroVadPath == null) {
      missingInputs.add('model:sileroVad:path');
    } else {
      await _verifyFile(
        File(options.sileroVadPath!),
        hashes['sileroVad'],
        'model:sileroVad',
        missingInputs,
      );
    }
  }
  for (final entry in <String, String?>{
    'runtime-root': options.runtimeRoot,
    'runtime-ort-1.24.4-root': options.ort1244RuntimeRoot,
    'worker': options.workerPath,
    'sandbox-launcher': options.sandboxLauncherPath,
    'native-launcher': options.nativeLauncherPath,
    'job-root': options.jobRoot,
  }.entries) {
    final path = entry.value;
    if (path == null ||
        (!File(path).existsSync() && !Directory(path).existsSync())) {
      missingInputs.add(entry.key);
    }
  }
  final outputPath = options.outputPath;
  if (outputPath == null || !File(outputPath).absolute.parent.existsSync()) {
    missingInputs.add('output-parent');
  }
  final control = _object(contract['control'], 'contract.control');
  await _verifyFile(
    File(options.runtimeArchivePath ?? ''),
    control['runtimeSha256'],
    'runtime-archive',
    missingInputs,
  );
  final runtimeArm = _list(contract['arms'], 'contract.arms')
      .map((value) => _object(value, 'contract.arm'))
      .singleWhere((arm) => arm['variable'] == 'runtime');
  await _verifyFile(
    File(options.ort1244RuntimeArchivePath ?? ''),
    runtimeArm['runtimeSha256'],
    'runtime-ort-1.24.4-archive',
    missingInputs,
  );
  try {
    final environmentProbe = await Process.run(
      options.pythonPath,
      const <String>['-c', 'import psutil, rapidfuzz'],
      includeParentEnvironment: false,
      environment: const <String, String>{
        'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
      },
    ).timeout(const Duration(seconds: 5));
    if (environmentProbe.exitCode != 0) {
      missingInputs.add('python-env:psutil-7.2.2+rapidfuzz-3.14.5');
    }
  } on Object {
    missingInputs.add('python-env:psutil-7.2.2+rapidfuzz-3.14.5');
  }
}

Future<Map<String, Object?>> _readPinnedJson({
  required Directory root,
  required Object? relativePath,
  required Object? expectedSha256,
  required String label,
}) async {
  if (relativePath is! String ||
      expectedSha256 is! String ||
      !_isSha256(expectedSha256)) {
    throw FormatException('$label identity is invalid');
  }
  final file = File('${root.path}/$relativePath');
  if (!await file.exists() || await _sha256File(file) != expectedSha256) {
    throw StateError('$label hash drifted');
  }
  return _object(jsonDecode(await file.readAsString()), label);
}

Future<bool> _verifyPackFile(
  Directory root,
  Map<String, Object?> identity,
  String label,
  List<String> missingInputs,
) async {
  final relativePath = identity['relativePath'];
  final expectedSha256 = identity['sha256'];
  if (relativePath is! String ||
      expectedSha256 is! String ||
      !_isSha256(expectedSha256)) {
    missingInputs.add('quality-pack:$label:pinned-identity');
    return false;
  }
  return _verifyFile(
    File('${root.path}/$relativePath'),
    expectedSha256,
    'quality-pack:$label',
    missingInputs,
  );
}

Future<bool> _verifyFile(
  File file,
  Object? expectedSha256,
  String label,
  List<String> missingInputs,
) async {
  if (expectedSha256 is! String ||
      !_isSha256(expectedSha256) ||
      !await file.exists() ||
      await _sha256File(file) != expectedSha256) {
    missingInputs.add(label);
    return false;
  }
  return true;
}

Future<bool> _verifyDirectory(
  Directory directory,
  Object? expectedSha256,
  String label,
  List<String> missingInputs,
) async {
  if (expectedSha256 is! String ||
      !_isSha256(expectedSha256) ||
      !await directory.exists() ||
      await _sha256Directory(directory) != expectedSha256) {
    missingInputs.add(label);
    return false;
  }
  return true;
}

Future<String> _sha256File(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();

Future<String> _sha256Directory(Directory directory) async {
  final files = await directory
      .list(followLinks: false)
      .where((entity) => entity is File)
      .cast<File>()
      .toList();
  if (files.isEmpty || files.length > 16) return '';
  files.sort((left, right) => left.path.compareTo(right.path));
  final identity = StringBuffer();
  for (final file in files) {
    identity
      ..write(file.uri.pathSegments.last)
      ..write('\u0000')
      ..write(await _sha256File(file))
      ..write('\n');
  }
  return sha256.convert(utf8.encode(identity.toString())).toString();
}

Future<void> _atomicJson(File destination, Map<String, Object?> value) async {
  await destination.parent.create(recursive: true);
  final temporary = File(
    '${destination.path}.$pid.${DateTime.now().microsecondsSinceEpoch}.tmp',
  );
  await temporary.writeAsString(
    '${const JsonEncoder.withIndent('  ').convert(value)}\n',
  );
  await temporary.rename(destination.path);
}

Map<String, Object?> _object(Object? value, String label) {
  if (value is! Map) throw FormatException('$label must be an object');
  return Map<String, Object?>.from(value);
}

List<Object?> _list(Object? value, String label) {
  if (value is! List) throw FormatException('$label must be a list');
  return List<Object?>.from(value);
}

bool _isSha256(String value) => RegExp(r'^[0-9a-f]{64}$').hasMatch(value);

final class _Options {
  const _Options({
    required this.contractPath,
    required this.execute,
    required this.arm,
    required this.audioRoot,
    required this.modelRoot,
    required this.sileroVadPath,
    required this.runtimeRoot,
    required this.runtimeArchivePath,
    required this.ort1244RuntimeRoot,
    required this.ort1244RuntimeArchivePath,
    required this.workerPath,
    required this.sandboxLauncherPath,
    required this.nativeLauncherPath,
    required this.jobRoot,
    required this.outputPath,
    required this.pythonPath,
  });

  factory _Options.parse(List<String> arguments) {
    final values = <String, String>{};
    var execute = false;
    for (var index = 0; index < arguments.length; index += 1) {
      final argument = arguments[index];
      if (argument == '--execute') {
        execute = true;
        continue;
      }
      if (!argument.startsWith('--') || index + 1 >= arguments.length) {
        throw FormatException('invalid runner argument: $argument');
      }
      final key = argument.substring(2);
      if (values.containsKey(key)) {
        throw FormatException('duplicate runner argument: $argument');
      }
      values[key] = arguments[++index];
    }
    const allowed = <String>{
      'contract',
      'arm',
      'audio-root',
      'model-root',
      'silero-vad',
      'runtime-root',
      'runtime-archive',
      'runtime-ort-1.24.4-root',
      'runtime-ort-1.24.4-archive',
      'worker',
      'sandbox-launcher',
      'native-launcher',
      'job-root',
      'output',
      'python',
    };
    if (values.keys.toSet().difference(allowed).isNotEmpty) {
      throw const FormatException('unknown runner argument');
    }
    return _Options(
      contractPath: values['contract'] ?? _defaultContractPath,
      execute: execute,
      arm: values['arm'],
      audioRoot: values['audio-root'],
      modelRoot: values['model-root'],
      sileroVadPath: values['silero-vad'],
      runtimeRoot: values['runtime-root'],
      runtimeArchivePath: values['runtime-archive'],
      ort1244RuntimeRoot: values['runtime-ort-1.24.4-root'],
      ort1244RuntimeArchivePath: values['runtime-ort-1.24.4-archive'],
      workerPath: values['worker'],
      sandboxLauncherPath: values['sandbox-launcher'],
      nativeLauncherPath: values['native-launcher'],
      jobRoot: values['job-root'],
      outputPath: values['output'],
      pythonPath: values['python'] ?? 'python3',
    );
  }

  final String contractPath;
  final bool execute;
  final String? arm;
  final String? audioRoot;
  final String? modelRoot;
  final String? sileroVadPath;
  final String? runtimeRoot;
  final String? runtimeArchivePath;
  final String? ort1244RuntimeRoot;
  final String? ort1244RuntimeArchivePath;
  final String? workerPath;
  final String? sandboxLauncherPath;
  final String? nativeLauncherPath;
  final String? jobRoot;
  final String? outputPath;
  final String pythonPath;
}
