import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';

import 'desktop_job.dart';
import 'desktop_processing_engine.dart';
import 'sherpa_desktop_processing_engine.dart';

const double frozenMacosDiarizationClusteringThreshold = 0.65;
const int frozenMacosWorkerThreads = 2;
const double frozenMacosLongMeetingShardThresholdSeconds = 3600;
const double frozenMacosLongMeetingShardOverlapSeconds = 120;

class NativeSherpaWorkerConfiguration {
  const NativeSherpaWorkerConfiguration({
    required this.launcherPath,
    required this.workerPath,
    required this.runtimeRoot,
    required this.importRoot,
    required this.models,
    this.diarizationClusteringThreshold =
        frozenMacosDiarizationClusteringThreshold,
    this.workerThreads = frozenMacosWorkerThreads,
    this.timeout = const Duration(minutes: 30),
  }) : assert(
         diarizationClusteringThreshold > 0 &&
             diarizationClusteringThreshold < 1 &&
             workerThreads > 0 &&
             workerThreads <= 8,
       );

  final String launcherPath;
  final String workerPath;
  final String runtimeRoot;
  final String importRoot;
  final SherpaDesktopModelSet models;
  final double diarizationClusteringThreshold;
  final int workerThreads;
  final Duration timeout;

  bool get isInstalled =>
      File(launcherPath).existsSync() &&
      File(workerPath).existsSync() &&
      Directory(runtimeRoot).existsSync() &&
      models.allFilesPresent;
}

class NativeSherpaWorkerEngine implements DesktopProcessingEngine {
  const NativeSherpaWorkerEngine(this.configuration);

  static const engineId = 'sherpa-onnx-1.13.4/zipformer14m-pyannote3';
  final NativeSherpaWorkerConfiguration configuration;

  @override
  bool get isAvailable => configuration.isInstalled;

  @override
  String get availabilityMessage => isAvailable
      ? '已安装并验证 macOS 准入模型；识别与说话人分离在可终止的隔离进程中运行。'
      : '准入模型或签名处理工作进程尚未安装；任务会安全保留。';

  @override
  Future<DesktopProcessingResult> process(
    DesktopProcessingJob job, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    _requireSafeSource(job.recordingPath);
    final started = Stopwatch()..start();
    final asr = await _runPhase(
      phase: 'asr',
      job: job,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
    cancellationToken.throwIfCancelled();
    Map<String, Object?>? diarization;
    String? diarizationError;
    try {
      final durationSeconds = (asr['durationSeconds'] as num?)?.toDouble();
      diarization =
          durationSeconds != null &&
              durationSeconds > frozenMacosLongMeetingShardThresholdSeconds
          ? await _runShardedDiarization(
              job: job,
              durationSeconds: durationSeconds,
              cancellationToken: cancellationToken,
              onProgress: onProgress,
            )
          : await _runPhase(
              phase: 'diarization',
              job: job,
              cancellationToken: cancellationToken,
              onProgress: onProgress,
            );
    } on ProcessingCancelled {
      rethrow;
    } on ProcessingTimedOut {
      rethrow;
    } catch (_) {
      diarizationError = 'DIARIZATION_FAILED';
    }
    final segments = _merge(asr, diarization);
    if (segments.isEmpty ||
        segments.length > ProcessingOperationalEnvelope.desktopV1.maxSegments) {
      throw StateError('native worker output exceeds the segment envelope');
    }
    started.stop();
    return DesktopProcessingResult(
      segments: segments,
      engineId: engineId,
      elapsedMilliseconds: started.elapsedMilliseconds,
      peakResidentBytes: max(
        (asr['residentBytes'] as num?)?.toInt() ?? 0,
        (diarization?['residentBytes'] as num?)?.toInt() ?? 0,
      ),
      diarizationSucceeded: diarization != null,
      diarizationErrorCode: diarizationError,
    );
  }

  Future<Map<String, Object?>> _runPhase({
    required String phase,
    required DesktopProcessingJob job,
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
    double? startSeconds,
    double? endSeconds,
  }) async {
    final arguments = <String>[
      configuration.workerPath,
      '--phase',
      phase,
      '--runtime-root',
      configuration.runtimeRoot,
      '--encoder',
      configuration.models.encoderPath,
      '--decoder',
      configuration.models.decoderPath,
      '--joiner',
      configuration.models.joinerPath,
      '--tokens',
      configuration.models.tokensPath,
      '--segmentation',
      configuration.models.segmentationPath,
      '--embedding',
      configuration.models.embeddingPath,
      '--diarization-threshold',
      configuration.diarizationClusteringThreshold.toString(),
      '--num-threads',
      configuration.workerThreads.toString(),
    ];
    if (phase == 'diarization' && startSeconds != null && endSeconds != null) {
      arguments.addAll(<String>[
        '--start-seconds',
        startSeconds.toString(),
        '--end-seconds',
        endSeconds.toString(),
      ]);
    }
    final process = await Process.start(
      configuration.launcherPath,
      arguments,
      mode: ProcessStartMode.normal,
      environment: const <String, String>{'LANG': 'C.UTF-8'},
      includeParentEnvironment: false,
    );
    final stderrBytes = <int>[];
    final stderrSubscription = process.stderr.listen((chunk) {
      if (stderrBytes.length < 256 * 1024) {
        stderrBytes.addAll(chunk.take(256 * 1024 - stderrBytes.length));
      }
    });
    final result = Completer<Map<String, Object?>>();
    var outputBytes = 0;
    final stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            outputBytes += utf8.encode(line).length + 1;
            if (outputBytes > 32 * 1024 * 1024) {
              if (!result.isCompleted) {
                result.completeError(
                  StateError('native worker output limit exceeded'),
                );
              }
              process.kill();
              return;
            }
            final Object? decoded;
            try {
              decoded = jsonDecode(line);
            } on FormatException catch (error) {
              if (!result.isCompleted) result.completeError(error);
              process.kill();
              return;
            }
            if (decoded is! Map<String, Object?> ||
                decoded['schemaVersion'] != 1) {
              if (!result.isCompleted) {
                result.completeError(
                  const FormatException('invalid native worker envelope'),
                );
              }
              process.kill();
              return;
            }
            if (decoded['type'] == 'progress') {
              final fraction = decoded['fraction'];
              final reportedPhase = decoded['phase'];
              if (fraction is num && reportedPhase is String) {
                onProgress(
                  ProcessingProgress(
                    phase: reportedPhase,
                    fraction: fraction.toDouble().clamp(0, 1),
                  ),
                );
              }
              return;
            }
            if (decoded['type'] == 'error') {
              if (!result.isCompleted) {
                result.completeError(
                  StateError(
                    'native worker failed: ${decoded['code'] ?? 'UNKNOWN'}',
                  ),
                );
              }
              return;
            }
            if (decoded['type'] == 'result' &&
                decoded['phase'] == phase &&
                decoded['sourceSha256'] == job.fingerprintSha256) {
              if (!result.isCompleted) result.complete(decoded);
            }
          },
          onError: (Object error) {
            if (!result.isCompleted) result.completeError(error);
          },
        );
    process.stdin.writeln(
      jsonEncode(<String, Object?>{
        'schemaVersion': 1,
        'sourcePath': job.recordingPath,
        'sourceSha256': job.fingerprintSha256,
      }),
    );
    await process.stdin.close();
    var processExited = false;
    Future<void>? termination;
    Future<void> terminate() => termination ??= _terminateProcessGroup(process);
    final exitCode = process.exitCode;
    unawaited(
      exitCode.then((exit) {
        processExited = true;
        if (!result.isCompleted) {
          result.completeError(
            StateError(
              'native worker exited $exit before a result: '
              '${utf8.decode(stderrBytes, allowMalformed: true)}',
            ),
          );
        }
      }),
    );

    Timer? deadline;
    Timer? cancellationPoll;
    deadline = Timer(configuration.timeout, () {
      if (!result.isCompleted) {
        result.completeError(const ProcessingTimedOut());
      }
      unawaited(terminate());
    });
    cancellationPoll = Timer.periodic(const Duration(milliseconds: 50), (_) {
      if (!cancellationToken.isCancelled) return;
      if (!result.isCompleted) {
        result.completeError(const ProcessingCancelled());
      }
      unawaited(terminate());
    });
    try {
      final outcome = await result.future;
      final exit = await exitCode;
      if (exit != 0) {
        throw StateError(
          'native worker exited $exit: ${utf8.decode(stderrBytes)}',
        );
      }
      return outcome;
    } finally {
      deadline.cancel();
      cancellationPoll.cancel();
      await stdoutSubscription.cancel();
      await stderrSubscription.cancel();
      if (!processExited) await terminate();
    }
  }

  Future<Map<String, Object?>> _runShardedDiarization({
    required DesktopProcessingJob job,
    required double durationSeconds,
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    final midpoint = durationSeconds / 2;
    final halfOverlap = frozenMacosLongMeetingShardOverlapSeconds / 2;
    final shardCancellation = ProcessingCancellationToken();
    final shardProgress = <double>[0.45, 0.45];
    final cancellationMirror = Timer.periodic(
      const Duration(milliseconds: 50),
      (_) {
        if (cancellationToken.isCancelled) shardCancellation.cancel();
      },
    );
    void report(int index, ProcessingProgress progress) {
      shardProgress[index] = progress.fraction;
      onProgress(
        ProcessingProgress(
          phase: 'diarization',
          fraction: (shardProgress[0] + shardProgress[1]) / 2,
        ),
      );
    }

    try {
      final results = await Future.wait(<Future<Map<String, Object?>>>[
        _runPhase(
          phase: 'diarization',
          job: job,
          cancellationToken: shardCancellation,
          onProgress: (progress) => report(0, progress),
          startSeconds: 0,
          endSeconds: min(durationSeconds, midpoint + halfOverlap),
        ),
        _runPhase(
          phase: 'diarization',
          job: job,
          cancellationToken: shardCancellation,
          onProgress: (progress) => report(1, progress),
          startSeconds: max(0, midpoint - halfOverlap),
          endSeconds: durationSeconds,
        ),
      ], eagerError: true);
      return mergeDiarizationShardResults(
        first: results[0],
        second: results[1],
        splitSeconds: midpoint,
        overlapStartSeconds: max(0, midpoint - halfOverlap),
        overlapEndSeconds: min(durationSeconds, midpoint + halfOverlap),
      );
    } catch (_) {
      shardCancellation.cancel();
      rethrow;
    } finally {
      cancellationMirror.cancel();
    }
  }

  List<ProcessingTranscriptSegment> _merge(
    Map<String, Object?> asr,
    Map<String, Object?>? diarization,
  ) {
    final text = asr['text'];
    final duration = (asr['durationSeconds'] as num?)?.toDouble();
    final tokens = asr['tokens'];
    final timestamps = asr['timestamps'];
    if (text is! String || text.trim().isEmpty || duration == null) {
      throw const FormatException('invalid ASR worker result');
    }
    if (tokens is! List<Object?> ||
        timestamps is! List<Object?> ||
        tokens.length != timestamps.length ||
        tokens.isEmpty) {
      return <ProcessingTranscriptSegment>[
        ProcessingTranscriptSegment(
          startSeconds: 0,
          endSeconds: duration,
          text: text,
          speakerAssignment: SpeakerAssignment.unknown,
        ),
      ];
    }
    final turns = <_SpeakerTurn>[];
    final rawTurns = diarization?['turns'];
    if (rawTurns is List<Object?>) {
      for (final raw in rawTurns) {
        if (raw is! Map<String, Object?>) continue;
        final start = (raw['startSeconds'] as num?)?.toDouble();
        final end = (raw['endSeconds'] as num?)?.toDouble();
        final key = raw['speakerKey'];
        if (start != null &&
            end != null &&
            end > start &&
            key is String &&
            key.isNotEmpty) {
          turns.add(_SpeakerTurn(start: start, end: end, key: key));
        }
      }
    }
    return List<ProcessingTranscriptSegment>.generate(tokens.length, (index) {
      final token = tokens[index];
      final start = (timestamps[index] as num?)?.toDouble();
      if (token is! String || start == null) {
        throw const FormatException('invalid ASR token timestamp');
      }
      final next = index + 1 < timestamps.length
          ? (timestamps[index + 1] as num?)?.toDouble()
          : duration;
      final end = max(start + 0.001, min(duration, next ?? duration));
      final active = turns
          .where((turn) => turn.start < end && turn.end > start)
          .map((turn) => turn.key)
          .toSet();
      return ProcessingTranscriptSegment(
        startSeconds: start.clamp(0, duration),
        endSeconds: end,
        text: token,
        speakerAssignment: active.length > 1
            ? SpeakerAssignment.overlap
            : active.isEmpty
            ? SpeakerAssignment.unknown
            : SpeakerAssignment.anonymous,
        anonymousSpeakerKey: active.length == 1 ? active.single : null,
      );
    });
  }

  void _requireSafeSource(String sourcePath) {
    final root = p.canonicalize(configuration.importRoot);
    final source = p.canonicalize(sourcePath);
    if (source == root || !p.isWithin(root, source)) {
      throw StateError(
        'native worker source is outside the managed import root',
      );
    }
    final type = FileSystemEntity.typeSync(source, followLinks: false);
    if (type != FileSystemEntityType.file) {
      throw StateError('native worker source must be a managed regular file');
    }
  }

  Future<void> _terminateProcessGroup(Process process) async {
    if (await _signalProcessGroup(process.pid, 'TERM')) {
      try {
        await process.exitCode.timeout(const Duration(milliseconds: 500));
        return;
      } on TimeoutException {
        // Escalate a worker that ignored graceful termination.
      }
    }
    await _signalProcessGroup(process.pid, 'KILL');
    try {
      await process.exitCode.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
    }
  }

  Future<bool> _signalProcessGroup(int pid, String signal) async {
    try {
      final result = await Process.run('/bin/kill', <String>[
        '-$signal',
        '-$pid',
      ]);
      return result.exitCode == 0;
    } on Object {
      return false;
    }
  }
}

Map<String, Object?> mergeDiarizationShardResults({
  required Map<String, Object?> first,
  required Map<String, Object?> second,
  required double splitSeconds,
  required double overlapStartSeconds,
  required double overlapEndSeconds,
}) {
  if (!(overlapStartSeconds < splitSeconds &&
      splitSeconds < overlapEndSeconds)) {
    throw const FormatException('invalid diarization shard overlap');
  }
  final firstTurns = _decodeTurns(first['turns']);
  final secondTurns = _decodeTurns(second['turns']);
  if (firstTurns.isEmpty || secondTurns.isEmpty) {
    throw const FormatException('empty diarization shard');
  }

  final scores = <_SpeakerPairScore>[];
  for (final left in firstTurns) {
    for (final right in secondTurns) {
      if (left.key == right.key &&
          (left.end <= overlapStartSeconds ||
              right.start >= overlapEndSeconds)) {
        continue;
      }
      final overlap = max(
        0.0,
        min(min(left.end, right.end), overlapEndSeconds) -
            max(max(left.start, right.start), overlapStartSeconds),
      );
      if (overlap > 0) {
        scores.add(
          _SpeakerPairScore(
            firstKey: left.key,
            secondKey: right.key,
            overlapSeconds: overlap,
          ),
        );
      }
    }
  }
  scores.sort(
    (left, right) => right.overlapSeconds.compareTo(left.overlapSeconds),
  );
  final usedFirst = <String>{};
  final usedSecond = <String>{};
  final secondKeyMapping = <String, String>{};
  for (final score in scores) {
    if (usedFirst.contains(score.firstKey) ||
        usedSecond.contains(score.secondKey)) {
      continue;
    }
    usedFirst.add(score.firstKey);
    usedSecond.add(score.secondKey);
    secondKeyMapping[score.secondKey] = score.firstKey;
  }
  for (final key in secondTurns.map((turn) => turn.key).toSet()) {
    secondKeyMapping.putIfAbsent(key, () => 'shard_02_$key');
  }

  final output = <Map<String, Object?>>[];
  for (final turn in firstTurns) {
    final end = min(turn.end, splitSeconds);
    if (end <= turn.start) continue;
    output.add(<String, Object?>{
      'startSeconds': turn.start,
      'endSeconds': end,
      'speakerKey': turn.key,
    });
  }
  for (final turn in secondTurns) {
    final start = max(turn.start, splitSeconds);
    if (turn.end <= start) continue;
    output.add(<String, Object?>{
      'startSeconds': start,
      'endSeconds': turn.end,
      'speakerKey': secondKeyMapping[turn.key]!,
    });
  }
  output.sort(
    (left, right) => (left['startSeconds']! as double).compareTo(
      right['startSeconds']! as double,
    ),
  );
  return <String, Object?>{
    'schemaVersion': 1,
    'type': 'result',
    'phase': 'diarization',
    'sourceSha256': first['sourceSha256'],
    'turns': output,
    'residentBytes':
        ((first['residentBytes'] as num?)?.toInt() ?? 0) +
        ((second['residentBytes'] as num?)?.toInt() ?? 0),
    'shardCount': 2,
    'shardOverlapSeconds': overlapEndSeconds - overlapStartSeconds,
  };
}

List<_SpeakerTurn> _decodeTurns(Object? raw) {
  if (raw is! List<Object?>) return const <_SpeakerTurn>[];
  return raw
      .whereType<Map<String, Object?>>()
      .map((turn) {
        final start = (turn['startSeconds'] as num?)?.toDouble();
        final end = (turn['endSeconds'] as num?)?.toDouble();
        final key = turn['speakerKey'];
        if (start == null ||
            end == null ||
            end <= start ||
            key is! String ||
            key.isEmpty) {
          throw const FormatException('invalid diarization shard turn');
        }
        return _SpeakerTurn(start: start, end: end, key: key);
      })
      .toList(growable: false);
}

class _SpeakerTurn {
  const _SpeakerTurn({
    required this.start,
    required this.end,
    required this.key,
  });

  final double start;
  final double end;
  final String key;
}

class _SpeakerPairScore {
  const _SpeakerPairScore({
    required this.firstKey,
    required this.secondKey,
    required this.overlapSeconds,
  });

  final String firstKey;
  final String secondKey;
  final double overlapSeconds;
}
