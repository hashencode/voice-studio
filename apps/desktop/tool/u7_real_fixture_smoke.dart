import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/meetings/data/desktop_meeting_workspace_repository.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_engine.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';
import 'package:voice2text_desktop/features/processing/frozen_sherpa_model_manager.dart';
import 'package:voice2text_desktop/features/processing/native_sherpa_worker_engine.dart';

Future<void> main() async {
  final output = await runU7RealFixtureSmoke();
  stdout.writeln(const JsonEncoder.withIndent('  ').convert(output));
}

Future<Map<String, Object?>> runU7RealFixtureSmoke() async {
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
  final modelRoot = Directory(
    Platform.environment['VOICE2TEXT_U7_MODEL_CACHE'] ??
        p.join(Directory.systemTemp.path, 'voice2text-u7-frozen-models'),
  );
  final manager = FrozenSherpaModelManager(
    root: modelRoot,
    fetcher: const HttpsFrozenSherpaFetcher(),
    capacityProbe: const MacosFrozenSherpaCapacityProbe(),
  );
  final installWatch = Stopwatch()..start();
  final installation = await manager.install(
    manifest,
    onProgress: (progress) {
      stderr.writeln('model-install ${(progress * 100).round()}%');
    },
  );
  installWatch.stop();

  final temporary = await Directory.systemTemp.createTemp(
    'voice2text-u7-real-smoke-',
  );
  AppDatabase? database;
  try {
    final importRoot = Directory(p.join(temporary.path, 'imports'));
    await importRoot.create();
    final sourceFixture = File(
      p.join(repositoryRoot.path, 'assets', 'sherpa', 'wav', 'test.wav'),
    );
    final sourceBytes = await sourceFixture.readAsBytes();
    final fingerprint = sha256.convert(sourceBytes).toString();
    final source = File(p.join(importRoot.path, '$fingerprint.wav'));
    await source.writeAsBytes(sourceBytes, flush: true);

    final databaseRoot = Directory(p.join(temporary.path, 'database'));
    await databaseRoot.create();
    database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => databaseRoot.path,
      databaseName: 'u7-real-smoke.db',
    );
    final processingRepository = DesktopProcessingRepository(
      database: database,
    );
    await processingRepository.commitImported(
      MeetingMediaCandidate(
        path: source.path,
        displayName: 'U7 真实中文会议.wav',
        sizeBytes: sourceBytes.length,
        durationMs: 272000,
        fingerprintSha256: fingerprint,
        duplicateAsset: false,
      ),
    );

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
    final processingResources = Directory(
      p.join(app.path, 'Contents', 'Resources', 'Processing'),
    );
    final runtimeRoot = Directory(p.join(app.path, 'Contents', 'Frameworks'));
    final engine = NativeSherpaWorkerEngine(
      NativeSherpaWorkerConfiguration(
        launcherPath: p.join(
          processingResources.path,
          'native_process_group_launcher',
        ),
        workerPath: p.join(processingResources.path, 'desktop_sherpa_worker'),
        runtimeRoot: runtimeRoot.path,
        importRoot: importRoot.path,
        models: installation.models,
        timeout: const Duration(minutes: 30),
      ),
    );
    if (!engine.isAvailable) {
      throw StateError(
        'built worker, runtime, or frozen models are unavailable',
      );
    }
    final processingWatch = Stopwatch()..start();
    final processed = await DesktopProcessingCoordinator(
      repository: processingRepository,
      engine: engine,
    ).processNext();
    processingWatch.stop();
    final job = (await processingRepository.listJobs()).single;
    if (!processed || job.state.name != 'completed') {
      throw StateError('real processing failed: ${job.stage}/${job.errorCode}');
    }

    final workspaceService = MeetingWorkspaceService(
      port: DesktopMeetingWorkspaceRepository(database: database),
    );
    final openWatch = Stopwatch()..start();
    var workspace = (await workspaceService.openMeeting(job.recordingId))!;
    openWatch.stop();
    if (workspace.segments.isEmpty) {
      throw StateError('real worker published an empty transcript');
    }
    final first = workspace.segments.first;
    final reviewedText = '${first.text}（已核对）';
    await workspaceService.saveSegment(segmentId: first.id, text: reviewedText);
    await workspaceService.undo(workspace.summary.generationId!);
    await workspaceService.redo(workspace.summary.generationId!);
    workspace = (await workspaceService.openMeeting(job.recordingId))!;
    final activeSpeakers = workspace.speakers
        .where((speaker) => speaker.mergedIntoSpeakerId == null)
        .toList();
    var manualSpeakerPreserved = false;
    if (activeSpeakers.isNotEmpty) {
      final speaker = activeSpeakers.first;
      await workspaceService.renameSpeakers(<int, String>{speaker.id: '主持人'});
      await workspaceService.assignSpeaker(
        generationId: workspace.summary.generationId!,
        segmentId: first.id,
        speakerId: speaker.id,
        state: MeetingWorkspaceSpeakerState.assigned,
      );
      workspace = (await workspaceService.openMeeting(job.recordingId))!;
      manualSpeakerPreserved =
          workspace.segments.first.speakerSource == 'manual' &&
          workspace.segments.first.speakerName == '主持人';
    }
    final searchWatch = Stopwatch()..start();
    final search = await workspaceService.searchTranscript(
      recordingId: job.recordingId,
      query: workspace.segments.first.text,
      limit: 20,
    );
    searchWatch.stop();
    final exports = <String, int>{};
    for (final format in MeetingWorkspaceExportFormat.values) {
      exports[format.name] = utf8
          .encode(workspaceService.export(workspace, format).contents)
          .length;
    }
    final appSignature = await Process.run('/usr/bin/codesign', <String>[
      '--verify',
      '--deep',
      '--strict',
      app.path,
    ]);
    return <String, Object?>{
      'schemaVersion': 1,
      'unit': 'U7',
      'fixture': p.relative(sourceFixture.path, from: repositoryRoot.path),
      'fixtureSha256': fingerprint,
      'fixtureBytes': sourceBytes.length,
      'manifestContentKey': manifest.contentKey,
      'modelInstallReused': installation.reused,
      'modelInstallElapsedMs': installWatch.elapsedMilliseconds,
      'workerProcessBoundary': 'native_worker_process_group',
      'builtAppCodesignVerified': appSignature.exitCode == 0,
      'jobState': job.state.name,
      'jobStage': job.stage,
      'processingElapsedMs': processingWatch.elapsedMilliseconds,
      'workspaceOpenMs': openWatch.elapsedMilliseconds,
      'searchMs': searchWatch.elapsedMilliseconds,
      'searchMatches': search.length,
      'segmentCount': workspace.segments.length,
      'speakerCount': activeSpeakers.length,
      'reviewEditUndoRedoPreserved':
          workspace.segments.first.text == reviewedText,
      'manualSpeakerPreserved': manualSpeakerPreserved,
      'exportsUtf8Bytes': exports,
    };
  } finally {
    if (database != null) await (await database.database).close();
    if (await temporary.exists()) await temporary.delete(recursive: true);
  }
}
