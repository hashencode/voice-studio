import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:desktop_sherpa_worker/desktop_sherpa_worker.dart';
import 'package:path/path.dart' as path;

const sandboxExecutable = '/usr/bin/sandbox-exec';

class SandboxProbeEvidence {
  const SandboxProbeEvidence({
    required this.networkPermissionDenied,
    required this.userHomePermissionDenied,
    required this.networkExitCode,
    required this.userHomeExitCode,
  });

  final bool networkPermissionDenied;
  final bool userHomePermissionDenied;
  final int networkExitCode;
  final int userHomeExitCode;

  bool get admitted => networkPermissionDenied && userHomePermissionDenied;

  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': 2,
    'networkPermissionDenied': networkPermissionDenied,
    'userHomePermissionDenied': userHomePermissionDenied,
    'networkExitCode': networkExitCode,
    'userHomeExitCode': userHomeExitCode,
    'connectionRefusalAcceptedAsDenial': false,
    'admitted': admitted,
  };
}

class SandboxedCandidateLauncher {
  SandboxedCandidateLauncher({
    required this.roots,
    required this.nativeProcessGroupLauncher,
    required this.worker,
    this.sandboxPath = sandboxExecutable,
  });

  final SidecarRoots roots;
  final File nativeProcessGroupLauncher;
  final File worker;
  final String sandboxPath;

  Future<void> validate() async {
    if (!Platform.isMacOS || !File(sandboxPath).existsSync()) {
      throw StateError('BENCHMARK_SANDBOX_UNAVAILABLE');
    }
    for (final executable in <File>[nativeProcessGroupLauncher, worker]) {
      final resolved = await executable.resolveSymbolicLinks();
      if (!_isContained(roots.toolRoot, resolved) ||
          FileSystemEntity.typeSync(resolved, followLinks: false) !=
              FileSystemEntityType.file) {
        throw StateError('BENCHMARK_EXECUTABLE_UNAVAILABLE');
      }
    }
  }

  List<String> get launchCommand => <String>[
    nativeProcessGroupLauncher.path,
    sandboxPath,
    '-p',
    SidecarSandboxProfile.macos(roots),
    worker.path,
    '--runtime-root',
    roots.runtimeRoot,
  ];

  Map<String, String> minimalEnvironment() => <String, String>{
    'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
    'LANG': 'C.UTF-8',
    'LC_ALL': 'C.UTF-8',
    'TMPDIR': roots.jobRoot,
    'HF_HUB_OFFLINE': '1',
    'HF_HUB_DISABLE_TELEMETRY': '1',
    'MODELSCOPE_OFFLINE': '1',
  };

  Future<SandboxProbeEvidence> activeDenialProbe() async {
    await validate();
    final profile = SidecarSandboxProfile.macos(roots);
    final home = Platform.environment['HOME'];
    if (home == null || home.isEmpty) {
      throw StateError('BENCHMARK_HOME_UNAVAILABLE');
    }
    final network = await _probe(
      profile,
      const <String>[
        'import socket',
        's=socket.socket()',
        's.settimeout(1)',
        's.connect(("127.0.0.1",9))',
      ].join(';'),
    );
    final userHome = await _probe(
      profile,
      'import os; os.listdir(${jsonEncode(home)})',
    );
    final evidence = SandboxProbeEvidence(
      networkPermissionDenied: _isPermissionDenial(network),
      userHomePermissionDenied: _isPermissionDenial(userHome),
      networkExitCode: network.exitCode,
      userHomeExitCode: userHome.exitCode,
    );
    if (!evidence.admitted) {
      throw StateError('BENCHMARK_SANDBOX_PROBE_FAILED');
    }
    return evidence;
  }

  Future<Process> start({bool requireProbe = true}) async {
    if (requireProbe) {
      await activeDenialProbe();
    } else {
      await validate();
    }
    final command = launchCommand;
    return Process.start(
      command.first,
      command.skip(1).toList(growable: false),
      workingDirectory: roots.jobRoot,
      environment: minimalEnvironment(),
      includeParentEnvironment: false,
      mode: ProcessStartMode.normal,
    );
  }

  Future<void> validateWorkerRequest(Map<String, Object?> request) async {
    final sourcePath = request['sourcePath'];
    final modelFiles = request['modelFiles'];
    if (sourcePath is! String || modelFiles is! Map<String, Object?>) {
      throw const FormatException('candidate worker paths are missing');
    }
    await roots.requireContainedSource(File(sourcePath));
    final family = request['family'];
    for (final entry in modelFiles.entries) {
      final value = entry.value;
      if (value is! Map<String, Object?> || value['path'] is! String) {
        throw const FormatException('candidate model path is invalid');
      }
      final modelPath = value['path']! as String;
      if ({'funasr_nano', 'qwen3_asr'}.contains(family) &&
          entry.key == 'tokenizer') {
        await _requireContainedTokenizerDirectory(
          roots.modelRoot,
          Directory(modelPath),
        );
      } else {
        await _requireContainedRegularFile(roots.modelRoot, File(modelPath));
      }
    }
  }

  Future<ProcessResult> _probe(String profile, String source) {
    return Process.run(
      sandboxPath,
      <String>['-p', profile, '/usr/bin/python3', '-c', source],
      workingDirectory: roots.jobRoot,
      environment: minimalEnvironment(),
      includeParentEnvironment: false,
    ).timeout(const Duration(seconds: 5));
  }

  static bool _isPermissionDenial(ProcessResult result) {
    final output = '${result.stdout}\n${result.stderr}'.toLowerCase();
    return result.exitCode != 0 &&
        !output.contains('connection refused') &&
        (output.contains('operation not permitted') ||
            output.contains('permission denied') ||
            output.contains('errno 1') ||
            output.contains('errno 13'));
  }
}

Future<int> runLauncherCli(List<String> arguments) async {
  if (arguments.isNotEmpty) {
    stderr.writeln('sandboxed-candidate-launcher: unexpected arguments');
    return 64;
  }
  final input = StreamIterator<String>(
    stdin.transform(utf8.decoder).transform(const LineSplitter()),
  );
  if (!await input.moveNext().timeout(const Duration(seconds: 5))) {
    throw const FormatException('launcher request is required');
  }
  final line = input.current;
  final value = jsonDecode(line);
  if (value is! Map<String, dynamic>) {
    throw const FormatException('launcher request must be an object');
  }
  final rootsValue = value['roots'];
  final workerRequest = value['workerRequest'];
  if (rootsValue is! Map<String, dynamic> ||
      workerRequest is! Map<String, dynamic>) {
    throw const FormatException(
      'launcher roots and worker request are required',
    );
  }
  Directory directory(String key) {
    final path = rootsValue[key];
    if (path is! String || path.isEmpty) {
      throw FormatException('launcher root $key is invalid');
    }
    return Directory(path);
  }

  final roots = await SidecarRoots.resolve(
    jobRoot: directory('jobRoot'),
    runtimeRoot: directory('runtimeRoot'),
    modelRoot: directory('modelRoot'),
    toolRoot: directory('toolRoot'),
  );
  final launcherPath = value['nativeProcessGroupLauncher'];
  final workerPath = value['worker'];
  if (launcherPath is! String || workerPath is! String) {
    throw const FormatException('launcher executable paths are invalid');
  }
  final launcher = SandboxedCandidateLauncher(
    roots: roots,
    nativeProcessGroupLauncher: File(launcherPath),
    worker: File(workerPath),
  );
  await launcher.validateWorkerRequest(
    Map<String, Object?>.from(workerRequest),
  );
  final probe = await launcher.activeDenialProbe();
  stderr.writeln(
    jsonEncode(<String, Object?>{
      'schemaVersion': 2,
      'type': 'sandboxProbe',
      ...probe.toJson(),
    }),
  );
  final process = await launcher.start(requireProbe: false);
  process.stdin.writeln(jsonEncode(workerRequest));
  final stdoutForward = forwardProcessStream(process.stdout, stdout);
  final stderrForward = forwardProcessStream(process.stderr, stderr);
  try {
    if (!await input.moveNext().timeout(const Duration(seconds: 10))) {
      throw const FormatException('baseline acknowledgement is required');
    }
    process.stdin.writeln(input.current);
    await process.stdin.close();
    final exitCode = await process.exitCode;
    await Future.wait(<Future<void>>[stdoutForward, stderrForward]);
    return exitCode;
  } catch (_) {
    process.kill();
    await process.stdin.close();
    await process.exitCode;
    await Future.wait(<Future<void>>[stdoutForward, stderrForward]);
    rethrow;
  } finally {
    await input.cancel();
  }
}

Future<void> forwardProcessStream(
  Stream<List<int>> source,
  IOSink destination,
) async {
  await for (final chunk in source) {
    destination.add(chunk);
    await destination.flush();
  }
}

Future<void> main(List<String> arguments) async {
  exitCode = await runLauncherCli(arguments);
}

Future<void> _requireContainedRegularFile(String root, File file) async {
  final resolved = path.normalize(await file.resolveSymbolicLinks());
  if (!_isContained(root, resolved) ||
      FileSystemEntity.typeSync(resolved, followLinks: false) !=
          FileSystemEntityType.file) {
    throw const FileSystemException('BENCHMARK_PATH_ESCAPE');
  }
}

Future<void> _requireContainedTokenizerDirectory(
  String root,
  Directory directory,
) async {
  final resolved = path.normalize(await directory.resolveSymbolicLinks());
  if (!_isContained(root, resolved) ||
      FileSystemEntity.typeSync(resolved, followLinks: false) !=
          FileSystemEntityType.directory) {
    throw const FileSystemException('BENCHMARK_PATH_ESCAPE');
  }
  final entities = await directory.list(followLinks: false).toList();
  if (entities.isEmpty || entities.length > 16) {
    throw const FileSystemException('BENCHMARK_TOKENIZER_DIRECTORY_INVALID');
  }
  for (final entity in entities) {
    if (entity is! File) {
      throw const FileSystemException('BENCHMARK_TOKENIZER_DIRECTORY_INVALID');
    }
    await _requireContainedRegularFile(root, entity);
  }
}

bool _isContained(String root, String candidate) =>
    path.isWithin(path.normalize(root), path.normalize(candidate));
