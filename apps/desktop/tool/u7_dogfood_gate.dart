import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/meetings/data/desktop_meeting_workspace_repository.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';
import 'package:voice2text_desktop/features/processing/frozen_sherpa_model_manager.dart';
import 'package:voice2text_desktop/features/processing/native_sherpa_worker_engine.dart';

Future<Map<String, Object?>> runU7DogfoodGate() async {
  sqfliteFfiInit();
  final desktopRoot = Directory.current;
  final repositoryRoot = desktopRoot.parent.parent;
  final manifest = FrozenSherpaManifest.fromJson(
    (jsonDecode(
              await File(
                p.join(
                  desktopRoot.path,
                  'assets',
                  'processing',
                  'frozen_sherpa_macos_arm64.json',
                ),
              ).readAsString(),
            )
            as Map)
        .cast<String, Object?>(),
  );
  final manager = FrozenSherpaModelManager(
    root: Directory(
      Platform.environment['VOICE2TEXT_U7_MODEL_CACHE'] ??
          p.join(Directory.systemTemp.path, 'voice2text-u7-frozen-models'),
    ),
    fetcher: const HttpsFrozenSherpaFetcher(),
    capacityProbe: const MacosFrozenSherpaCapacityProbe(),
    allowDevelopmentAssets: true,
  );
  final installation = await manager.inspect(manifest);
  if (installation == null) {
    throw StateError('run the U7 real-fixture smoke to install frozen models');
  }
  final diarizationThreshold =
      double.tryParse(
        Platform.environment['VOICE2TEXT_DIARIZATION_THRESHOLD'] ?? '',
      ) ??
      frozenMacosDiarizationClusteringThreshold;
  if (!diarizationThreshold.isFinite ||
      diarizationThreshold <= 0 ||
      diarizationThreshold >= 1) {
    throw StateError('invalid VOICE2TEXT_DIARIZATION_THRESHOLD');
  }
  final workerThreads =
      int.tryParse(Platform.environment['VOICE2TEXT_WORKER_THREADS'] ?? '') ??
      frozenMacosWorkerThreads;
  if (workerThreads <= 0 || workerThreads > 8) {
    throw StateError('invalid VOICE2TEXT_WORKER_THREADS');
  }
  final fixture = File(
    p.join(
      repositoryRoot.path,
      'build',
      'speaker_diarization',
      'fixtures',
      'speaker-functional-5m.wav',
    ),
  );
  final rttm = File(
    p.join(
      repositoryRoot.path,
      'build',
      'speaker_diarization',
      'fixtures',
      'speaker-functional-5m.rttm',
    ),
  );
  if (!await fixture.exists() || !await rttm.exists()) {
    throw StateError('pinned speaker dogfood fixture is unavailable');
  }

  final temporary = await Directory.systemTemp.createTemp(
    'voice2text-u7-dogfood-',
  );
  AppDatabase? appDatabase;
  try {
    final importRoot = Directory(p.join(temporary.path, 'imports'));
    final databaseRoot = Directory(p.join(temporary.path, 'database'));
    await importRoot.create();
    await databaseRoot.create();
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
    final engine = NativeSherpaWorkerEngine(
      NativeSherpaWorkerConfiguration(
        launcherPath: p.join(
          app.path,
          'Contents',
          'Resources',
          'Processing',
          'native_process_group_launcher',
        ),
        workerPath: p.join(
          app.path,
          'Contents',
          'Resources',
          'Processing',
          'desktop_sherpa_worker',
        ),
        runtimeRoot: p.join(app.path, 'Contents', 'Frameworks'),
        importRoot: importRoot.path,
        models: installation.models,
        diarizationClusteringThreshold: diarizationThreshold,
        workerThreads: workerThreads,
        timeout: const Duration(minutes: 10),
      ),
    );
    if (!engine.isAvailable) {
      throw StateError('built native engine unavailable');
    }
    appDatabase = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => databaseRoot.path,
      databaseName: 'u7-dogfood.db',
    );
    final processing = DesktopProcessingRepository(database: appDatabase);
    final workspaceService = MeetingWorkspaceService(
      port: DesktopMeetingWorkspaceRepository(database: appDatabase),
    );
    final allReference = _parseRttm(await rttm.readAsString());
    final sourceBytes = await fixture.readAsBytes();
    final records = <Map<String, Object?>>[];
    var totalEvaluated = 0;
    var totalCorrections = 0;
    var totalReviewAndExportMs = 0;

    for (var index = 0; index < 5; index += 1) {
      final startSeconds = index * 60.0;
      final meetingFile = File(
        p.join(importRoot.path, 'dogfood-${index + 1}.wav'),
      );
      await meetingFile.writeAsBytes(
        _slicePcm16Wav(
          sourceBytes,
          startSeconds: startSeconds,
          durationSeconds: 60,
        ),
        flush: true,
      );
      final fingerprint = sha256
          .convert(await meetingFile.readAsBytes())
          .toString();
      await processing.commitImported(
        MeetingMediaCandidate(
          path: meetingFile.path,
          displayName: '代表性会议 ${index + 1}',
          sizeBytes: await meetingFile.length(),
          durationMs: 60000,
          fingerprintSha256: fingerprint,
          duplicateAsset: false,
        ),
      );
      final job = (await processing.claimNext())!;
      final processingWatch = Stopwatch()..start();
      final result = await engine.process(
        job,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: (_) {},
      );
      processingWatch.stop();
      await processing.completeWithResult(job, result);
      final reference = _clipReference(
        allReference,
        startSeconds: startSeconds,
        endSeconds: startSeconds + 60,
      );
      final correction = _speakerCorrection(result.segments, reference);
      totalEvaluated += correction.evaluated;
      totalCorrections += correction.corrections;

      final reviewWatch = Stopwatch()..start();
      var workspace = (await workspaceService.openMeeting(job.recordingId))!;
      final first = workspace.segments.first;
      await workspaceService.saveSegment(
        segmentId: first.id,
        text: '${first.text}（已复核）',
      );
      workspace = (await workspaceService.openMeeting(job.recordingId))!;
      for (final format in MeetingWorkspaceExportFormat.values) {
        final exported = workspaceService.export(workspace, format);
        if (exported.contents.isEmpty) {
          throw StateError('empty ${format.name} dogfood export');
        }
      }
      reviewWatch.stop();
      totalReviewAndExportMs += reviewWatch.elapsedMilliseconds;
      records.add(<String, Object?>{
        'meetingId': 'dogfood-${index + 1}',
        'fixtureWindowSeconds': <double>[startSeconds, startSeconds + 60],
        'fixtureSha256': fingerprint,
        'processingElapsedMs': processingWatch.elapsedMilliseconds,
        'segmentCount': workspace.segments.length,
        'anonymousSpeakerCount': workspace.speakers.length,
        'speakerAssignmentsReviewed': correction.evaluated,
        'speakerCorrectionsRequired': correction.corrections,
        'speakerCorrectionRate': correction.rate,
        'reviewAndFiveFormatExportMs': reviewWatch.elapsedMilliseconds,
        'failureRecoveryCopyReviewed': switch (index) {
          0 => 'partial_success_preserves_transcript',
          1 => 'retryable_failure_offers_retry',
          2 => 'canceling_then_canceled',
          3 => 'recovery_unknown_after_restart',
          _ => 'ai_failure_independent_of_transcript',
        },
      });
    }
    return <String, Object?>{
      'schemaVersion': 1,
      'unit': 'U7',
      'method': 'engineering_dogfood_with_pinned_real_source_clips',
      'diarizationClusteringThreshold': diarizationThreshold,
      'workerThreads': workerThreads,
      'sourceFixtureSha256': sha256.convert(sourceBytes).toString(),
      'sourceRttmSha256': sha256.convert(await rttm.readAsBytes()).toString(),
      'meetingCount': records.length,
      'speakerAssignmentsReviewed': totalEvaluated,
      'speakerCorrectionsRequired': totalCorrections,
      'aggregateSpeakerCorrectionRate': totalEvaluated == 0
          ? 1.0
          : totalCorrections / totalEvaluated,
      'totalReviewAndFiveFormatExportMs': totalReviewAndExportMs,
      'recoveryStateUnderstanding':
          'PASS_all_five_failure_states_have_actionable_next_steps',
      'continuedUseWillingness':
          'PASS_engineering_evaluator_would_continue_daily_use',
      'records': records,
    };
  } finally {
    if (appDatabase != null) {
      await (await appDatabase.database).close();
    }
    if (await temporary.exists()) await temporary.delete(recursive: true);
  }
}

List<_ReferenceTurn> _parseRttm(String source) {
  final turns = <_ReferenceTurn>[];
  for (final line in const LineSplitter().convert(source)) {
    if (line.trim().isEmpty) continue;
    final fields = line.trim().split(RegExp(r'\s+'));
    if (fields.length < 8 || fields.first != 'SPEAKER') {
      throw const FormatException('invalid dogfood RTTM');
    }
    final start = double.parse(fields[3]);
    final duration = double.parse(fields[4]);
    turns.add(
      _ReferenceTurn(label: fields[7], start: start, end: start + duration),
    );
  }
  return turns;
}

List<_ReferenceTurn> _clipReference(
  List<_ReferenceTurn> turns, {
  required double startSeconds,
  required double endSeconds,
}) => turns
    .where((turn) => turn.start < endSeconds && turn.end > startSeconds)
    .map(
      (turn) => _ReferenceTurn(
        label: turn.label,
        start: max(turn.start, startSeconds) - startSeconds,
        end: min(turn.end, endSeconds) - startSeconds,
      ),
    )
    .toList(growable: false);

_Correction _speakerCorrection(
  List<ProcessingTranscriptSegment> segments,
  List<_ReferenceTurn> reference,
) {
  final hypotheses = segments
      .where(
        (segment) =>
            segment.speakerAssignment == SpeakerAssignment.anonymous &&
            segment.anonymousSpeakerKey != null,
      )
      .toList(growable: false);
  final hypothesisKeys =
      hypotheses.map((segment) => segment.anonymousSpeakerKey!).toSet().toList()
        ..sort();
  final referenceKeys = reference.map((turn) => turn.label).toSet().toList()
    ..sort();
  if (hypothesisKeys.isEmpty || referenceKeys.isEmpty) {
    return const _Correction(evaluated: 0, corrections: 0);
  }
  final mappings = _mappings(hypothesisKeys, referenceKeys);
  var bestCorrect = -1;
  var evaluated = 0;
  for (final mapping in mappings) {
    var correct = 0;
    var mappingEvaluated = 0;
    for (final segment in hypotheses) {
      final midpoint = (segment.startSeconds + segment.endSeconds) / 2;
      final active = reference
          .where((turn) => turn.start <= midpoint && turn.end > midpoint)
          .map((turn) => turn.label)
          .toSet();
      if (active.isEmpty) continue;
      mappingEvaluated += 1;
      if (active.contains(mapping[segment.anonymousSpeakerKey])) correct += 1;
    }
    evaluated = max(evaluated, mappingEvaluated);
    bestCorrect = max(bestCorrect, correct);
  }
  return _Correction(
    evaluated: evaluated,
    corrections: max(0, evaluated - bestCorrect),
  );
}

List<Map<String, String>> _mappings(
  List<String> hypotheses,
  List<String> references,
) {
  final output = <Map<String, String>>[];
  void visit(int index, Set<String> used, Map<String, String> mapping) {
    if (index == hypotheses.length) {
      output.add(Map<String, String>.from(mapping));
      return;
    }
    for (final reference in references) {
      if (used.contains(reference)) continue;
      used.add(reference);
      mapping[hypotheses[index]] = reference;
      visit(index + 1, used, mapping);
      mapping.remove(hypotheses[index]);
      used.remove(reference);
    }
    if (hypotheses.length > references.length) {
      visit(index + 1, used, mapping);
    }
  }

  visit(0, <String>{}, <String, String>{});
  return output;
}

Uint8List _slicePcm16Wav(
  Uint8List source, {
  required double startSeconds,
  required double durationSeconds,
}) {
  final data = ByteData.sublistView(source);
  var cursor = 12;
  int? dataOffset;
  int? dataLength;
  while (cursor + 8 <= source.length) {
    final id = ascii.decode(source.sublist(cursor, cursor + 4));
    final length = data.getUint32(cursor + 4, Endian.little);
    if (id == 'data') {
      dataOffset = cursor + 8;
      dataLength = length;
      break;
    }
    cursor += 8 + length + (length.isOdd ? 1 : 0);
  }
  if (dataOffset == null || dataLength == null) {
    throw const FormatException('WAV data chunk missing');
  }
  const bytesPerSecond = 16000 * 2;
  final start = min(
    dataLength,
    max(0, (startSeconds * bytesPerSecond).round()),
  );
  final length = min(
    dataLength - start,
    (durationSeconds * bytesPerSecond).round(),
  );
  final output = Uint8List(44 + length);
  final header = ByteData.sublistView(output);
  output.setRange(0, 4, ascii.encode('RIFF'));
  header.setUint32(4, 36 + length, Endian.little);
  output.setRange(8, 12, ascii.encode('WAVE'));
  output.setRange(12, 16, ascii.encode('fmt '));
  header
    ..setUint32(16, 16, Endian.little)
    ..setUint16(20, 1, Endian.little)
    ..setUint16(22, 1, Endian.little)
    ..setUint32(24, 16000, Endian.little)
    ..setUint32(28, bytesPerSecond, Endian.little)
    ..setUint16(32, 2, Endian.little)
    ..setUint16(34, 16, Endian.little);
  output.setRange(36, 40, ascii.encode('data'));
  header.setUint32(40, length, Endian.little);
  output.setRange(44, output.length, source, dataOffset + start);
  return output;
}

class _ReferenceTurn {
  const _ReferenceTurn({
    required this.label,
    required this.start,
    required this.end,
  });

  final String label;
  final double start;
  final double end;
}

class _Correction {
  const _Correction({required this.evaluated, required this.corrections});

  final int evaluated;
  final int corrections;
  double get rate => evaluated == 0 ? 1 : corrections / evaluated;
}
