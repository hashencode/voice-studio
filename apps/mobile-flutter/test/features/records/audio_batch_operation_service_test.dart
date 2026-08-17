import 'dart:convert';
import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/service/audio_export_service.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/records/service/audio_batch_operation_service.dart';
import 'package:voice2text_flutter/features/records/service/audio_deletion_coordinator.dart';
import 'package:voice2text_flutter/features/shared/service/ephemeral_share_artifact_service.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_segments_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'move and retry return a result for every mixed-state recording',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recordings = RecordingsRepository(database: fixture.appDatabase);
      final activeId = await _insertRecording(
        fixture,
        path: '/audios/active.m4a',
        title: 'Active',
      );
      final deletedId = await _insertRecording(
        fixture,
        path: '/audios/deleted.m4a',
        title: 'Deleted',
        deletedAtMs: 100,
      );
      final failedId = await _insertRecording(
        fixture,
        path: '/audios/failed.m4a',
        title: 'Failed',
      );
      final processingId = await _insertRecording(
        fixture,
        path: '/audios/processing.m4a',
        title: 'Processing',
      );
      await _insertJob(
        fixture,
        recordingId: failedId,
        path: '/audios/failed.m4a',
        status: 'failed',
      );
      await _insertJob(
        fixture,
        recordingId: processingId,
        path: '/audios/processing.m4a',
        status: 'processing',
      );
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      final service = AudioBatchOperationService(
        recordingsRepository: recordings,
        transcriptionJobsRepository: jobs,
        retryRecordings: (ids) => jobs.retryLatestForRecordingIds(ids),
      );

      final move = await service.move(<int>{
        activeId,
        deletedId,
        9999,
      }, targetGroup: '客户访谈');
      expect(move.items, hasLength(3));
      expect(
        move.forRecording(activeId).status,
        AudioBatchItemStatus.succeeded,
      );
      expect(move.forRecording(deletedId).reason, 'recording_deleted');
      expect(move.forRecording(9999).reason, 'recording_not_found');
      expect((await recordings.findById(activeId))?.groupName, '客户访谈');

      final retry = await service.retry(<int>{
        failedId,
        processingId,
        deletedId,
      });
      expect(
        retry.forRecording(failedId).status,
        AudioBatchItemStatus.succeeded,
      );
      expect(retry.forRecording(processingId).reason, 'job_not_retryable');
      expect(retry.forRecording(deletedId).reason, 'recording_deleted');
      expect(
        (await jobs.findLatestByRecordingPath('/audios/failed.m4a'))?.status,
        'pending',
      );
    },
  );

  test(
    'batch export creates unique entries, manifest, and no audio assets',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final root = await Directory.systemTemp.createTemp('batch-export-');
      addTearDown(() => root.delete(recursive: true));
      final recordings = RecordingsRepository(database: fixture.appDatabase);
      final firstId = await _insertRecording(
        fixture,
        path: '/audios/one.m4a',
        title: '同名/音频',
      );
      final secondId = await _insertRecording(
        fixture,
        path: '/audios/two.m4a',
        title: '同名/音频',
      );
      final emptyId = await _insertRecording(
        fixture,
        path: '/audios/empty.m4a',
        title: '无转写',
      );
      final segments = TranscriptSegmentsRepository(
        database: fixture.appDatabase,
      );
      await segments.upsertSegment(
        recordingPath: '/audios/one.m4a',
        sequenceId: 0,
        text: '第一份',
        startMs: 0,
        endMs: 1000,
      );
      await segments.upsertSegment(
        recordingPath: '/audios/two.m4a',
        sequenceId: 0,
        text: '第二份',
        startMs: 0,
        endMs: 1000,
      );
      final ephemeral = EphemeralShareArtifactService(
        rootDirectory: root,
        now: () => DateTime.fromMillisecondsSinceEpoch(1_750_000_000_000),
      );
      final service = AudioBatchOperationService(
        recordingsRepository: recordings,
        transcriptSegmentsRepository: segments,
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        audioExportService: AudioExportService(
          recordingsRepository: recordings,
        ),
        ephemeralShareArtifactService: ephemeral,
      );

      final result = await service.export(<int>{
        firstId,
        secondId,
        emptyId,
      }, format: AudioExportFormat.markdown);

      expect(result.artifact, isNotNull);
      expect(
        result.forRecording(firstId).status,
        AudioBatchItemStatus.succeeded,
      );
      expect(
        result.forRecording(secondId).status,
        AudioBatchItemStatus.succeeded,
      );
      expect(result.forRecording(emptyId).reason, 'transcript_unavailable');
      final archive = ZipDecoder().decodeBytes(
        await File(result.artifact!.path).readAsBytes(),
      );
      final names = archive.files.map((file) => file.name).toList();
      expect(names.where((name) => name.endsWith('.md')), hasLength(2));
      expect(names.toSet(), hasLength(names.length));
      expect(
        names.every((name) => !name.contains('/') && !name.contains(r'\')),
        isTrue,
      );
      final manifestFile = archive.files.singleWhere(
        (file) => file.name == 'manifest.json',
      );
      final manifest =
          jsonDecode(utf8.decode(manifestFile.content as List<int>))
              as Map<String, Object?>;
      expect(manifest['format'], 'markdown');
      expect(manifest['items'], hasLength(3));
      expect(await fixture.database.query('audio_assets'), isEmpty);
    },
  );

  test(
    'permanent delete preserves pending and can be retried item by item',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recordings = RecordingsRepository(database: fixture.appDatabase);
      final id = await _insertRecording(
        fixture,
        path: '/data/user/0/app/files/audios/delete.m4a',
        title: 'Delete',
        deletedAtMs: 100,
      );
      await recordings.registerOwnedAsset(
        recordingId: id,
        path: '/data/user/0/app/files/audios/exports/delete.md',
        kind: 'transcript_export',
      );
      final fileStore = _RetryDeleteFileStore();
      final service = AudioBatchOperationService(
        recordingsRepository: recordings,
        audioDeletionCoordinator: AudioDeletionCoordinator(
          recordingsRepository: recordings,
          fileStore: fileStore,
        ),
      );

      final first = await service.permanentlyDelete(<int>{id});

      expect(first.forRecording(id).status, AudioBatchItemStatus.failed);
      expect(first.forRecording(id).reason, 'deletion_pending');
      expect((await recordings.findById(id))?.deletionState, 'pending');

      fileStore.allow = true;
      final second = await service.permanentlyDelete(<int>{id});

      expect(second.forRecording(id).status, AudioBatchItemStatus.succeeded);
      expect(await recordings.findById(id), isNull);
    },
  );
}

class _RetryDeleteFileStore implements AudioFileStore {
  bool allow = false;

  @override
  Future<bool> deleteIfPresent(String path) async => allow;
}

Future<int> _insertRecording(
  dynamic fixture, {
  required String path,
  required String title,
  int? deletedAtMs,
}) {
  return fixture.database.insert('recordings', <String, Object?>{
    'file_path': path,
    'display_name': title,
    'group_name': null,
    'deleted_at_ms': deletedAtMs,
    'is_favorite': 0,
    'duration_ms': 60_000,
    'created_at_ms': DateTime.now().millisecondsSinceEpoch,
  });
}

Future<void> _insertJob(
  dynamic fixture, {
  required int recordingId,
  required String path,
  required String status,
}) async {
  final now = DateTime.now().millisecondsSinceEpoch;
  await fixture.database.insert('transcription_jobs', <String, Object?>{
    'recording_path': path,
    'duration_ms': 60_000,
    'status': status,
    'recording_mode': 'standard',
    'source': 'standard_offline',
    'stage': status,
    'progress': status == 'completed' ? 1.0 : 0.0,
    'attempt_count': 1,
    'cancel_requested': 0,
    'dedupe_key': '$path|standard_offline',
    'recording_id': recordingId,
    'created_at_ms': now,
    'updated_at_ms': now,
  });
}
