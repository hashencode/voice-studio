import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';
import 'package:voice2text_desktop/features/processing/frozen_sherpa_model_manager.dart';
import 'package:voice2text_desktop/features/processing/native_sherpa_worker_engine.dart';

Future<void> main() async {
  final evidence = await runU9LongMeetingGate();
  stdout.writeln('U9_LONG_MEETING_EVIDENCE=${jsonEncode(evidence)}');
  if (evidence['status'] != 'PASS') exitCode = 1;
}

Future<Map<String, Object?>> runU9LongMeetingGate() async {
  final desktopRoot = Directory.current;
  final repositoryRoot = desktopRoot.parent.parent;
  final manifestFile = File(
    p.join(
      desktopRoot.path,
      'assets',
      'processing',
      'frozen_sherpa_macos_arm64.json',
    ),
  );
  final manifest = FrozenSherpaManifest.fromJson(
    (jsonDecode(await manifestFile.readAsString()) as Map)
        .cast<String, Object?>(),
  );
  final manager = FrozenSherpaModelManager(
    root: Directory(
      Platform.environment['VOICE2TEXT_U7_MODEL_CACHE'] ??
          p.join(Directory.systemTemp.path, 'voice2text-u7-frozen-models'),
    ),
    fetcher: const HttpsFrozenSherpaFetcher(),
    capacityProbe: const MacosFrozenSherpaCapacityProbe(),
  );
  final installation = await manager.inspect(manifest);
  if (installation == null) {
    throw StateError('frozen U7 model set is not installed');
  }

  final fixture = File(
    p.join(
      repositoryRoot.path,
      'build',
      'speaker_diarization',
      'fixtures',
      'speaker-resource-120m.wav',
    ),
  );
  if (!await fixture.exists()) {
    throw StateError('pinned 120-minute fixture is unavailable');
  }
  final fixtureSha256 = await _sha256(fixture);
  if (fixtureSha256 !=
      '6a4f0849cee47ad9daecac04d92977c8cf6b48de1dd43849ad60852de5b336c3') {
    throw StateError('pinned 120-minute fixture hash drifted');
  }

  final app = Directory(
    p.join(
      desktopRoot.path,
      'build',
      'macos',
      'Build',
      'Products',
      'Debug',
      'voice2text_desktop.app',
    ),
  );
  final processingRoot = Directory(
    p.join(app.path, 'Contents', 'Resources', 'Processing'),
  );
  final runtimeRoot = Directory(p.join(app.path, 'Contents', 'Frameworks'));
  final launcher = File(
    p.join(processingRoot.path, 'native_process_group_launcher'),
  );
  final worker = File(p.join(processingRoot.path, 'desktop_sherpa_worker'));
  final engine = NativeSherpaWorkerEngine(
    NativeSherpaWorkerConfiguration(
      launcherPath: launcher.path,
      workerPath: worker.path,
      runtimeRoot: runtimeRoot.path,
      importRoot: fixture.parent.path,
      models: installation.models,
      timeout: const Duration(minutes: 35),
    ),
  );
  if (!engine.isAvailable) {
    throw StateError('built U9 product engine is unavailable');
  }

  var lastPhase = '';
  var lastBucket = -1;
  final stopwatch = Stopwatch()..start();
  final result = await engine.process(
    DesktopProcessingJob(
      id: 9001,
      recordingId: 9001,
      displayName: 'U9 120-minute gate',
      recordingPath: fixture.path,
      fingerprintSha256: fixtureSha256,
      state: DesktopJobState.processing,
      stage: 'preparing',
      progress: 0,
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
    ),
    cancellationToken: ProcessingCancellationToken(),
    onProgress: (progress) {
      final bucket = (progress.fraction * 10).floor();
      if (progress.phase != lastPhase || bucket != lastBucket) {
        lastPhase = progress.phase;
        lastBucket = bucket;
        stderr.writeln(
          'u9-long-meeting ${progress.phase} ${(progress.fraction * 100).round()}%',
        );
      }
    },
  );
  stopwatch.stop();

  final artifactHashes = <String, String>{
    'manifest': await _sha256(manifestFile),
    'native_process_group_launcher': await _sha256(launcher),
    'desktop_sherpa_worker': await _sha256(worker),
  };
  final runtimeFiles = await runtimeRoot
      .list()
      .where((entry) => entry is File)
      .cast<File>()
      .toList();
  runtimeFiles.sort((left, right) => left.path.compareTo(right.path));
  for (final file in runtimeFiles) {
    artifactHashes['runtime/${p.basename(file.path)}'] = await _sha256(file);
  }

  const durationMilliseconds = 2 * 60 * 60 * 1000;
  const thresholdMilliseconds = 30 * 60 * 1000;
  final passed =
      result.diarizationSucceeded &&
      result.segments.isNotEmpty &&
      stopwatch.elapsedMilliseconds < thresholdMilliseconds;
  return <String, Object?>{
    'schemaVersion': 1,
    'unit': 'U9',
    'status': passed ? 'PASS' : 'FAIL',
    'targetFingerprint': await _targetFingerprint(),
    'fixture': p.relative(fixture.path, from: repositoryRoot.path),
    'fixtureSha256': fixtureSha256,
    'fixtureBytes': await fixture.length(),
    'durationMilliseconds': durationMilliseconds,
    'thresholdMilliseconds': thresholdMilliseconds,
    'elapsedMilliseconds': stopwatch.elapsedMilliseconds,
    'realTimeFactor': stopwatch.elapsedMilliseconds / durationMilliseconds,
    'engineId': NativeSherpaWorkerEngine.engineId,
    'diarizationClusteringThreshold': frozenMacosDiarizationClusteringThreshold,
    'workerThreads': frozenMacosWorkerThreads,
    'longMeetingShardCount': 2,
    'longMeetingShardThresholdSeconds':
        frozenMacosLongMeetingShardThresholdSeconds,
    'longMeetingShardOverlapSeconds':
        frozenMacosLongMeetingShardOverlapSeconds,
    'manifestContentKey': manifest.contentKey,
    'segmentCount': result.segments.length,
    'diarizationSucceeded': result.diarizationSucceeded,
    'peakResidentBytes': result.peakResidentBytes,
    'artifactHashes': artifactHashes,
  };
}

Future<String> _sha256(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();

Future<Map<String, Object?>> _targetFingerprint() async {
  Future<String> value(String executable, List<String> arguments) async {
    final result = await Process.run(executable, arguments);
    if (result.exitCode != 0) {
      throw StateError('target fingerprint command failed: $executable');
    }
    return (result.stdout as String).trim();
  }

  return <String, Object?>{
    'operatingSystem': Platform.operatingSystem,
    'operatingSystemVersion': await value('/usr/bin/sw_vers', const <String>[
      '-productVersion',
    ]),
    'architecture': await value('/usr/bin/uname', const <String>['-m']),
    'cpuModel': await value('/usr/sbin/sysctl', const <String>[
      '-n',
      'machdep.cpu.brand_string',
    ]),
    'logicalCpuCount': Platform.numberOfProcessors,
    'memoryBytes': int.parse(
      await value('/usr/sbin/sysctl', const <String>['-n', 'hw.memsize']),
    ),
  };
}
