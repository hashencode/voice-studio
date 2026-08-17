import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_annotations_repository.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/records/service/meeting_deletion_coordinator.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'partial deletion remains pending and retry removes the graph',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = RecordingsRepository(database: fixture.appDatabase);
      final commit = await repository.insertImported(
        filePath: '/data/user/0/app/files/meetings/imports/complete/media.m4a',
        displayName: 'media.m4a',
        fingerprintSha256: 'delete-me',
        durationMs: 1000,
      );
      await repository.registerOwnedAsset(
        recordingId: commit.recordingId,
        path: '/data/user/0/app/files/meetings/exports/media.m4a',
        kind: 'share_export',
      );
      final fileStore = _RetryFileStore(
        failingPath: '/data/user/0/app/files/meetings/exports/media.m4a',
      );
      final coordinator = MeetingDeletionCoordinator(
        recordingsRepository: repository,
        fileStore: fileStore,
      );

      final first = await coordinator.permanentlyDelete(commit.recordingId);

      expect(first.completed, isFalse);
      expect(
        (await repository.findById(commit.recordingId))?.deletionState,
        'pending',
      );
      expect(await fixture.database.query('transcription_jobs'), hasLength(1));

      fileStore.allowRetry = true;
      final second = await coordinator.permanentlyDelete(commit.recordingId);

      expect(second.completed, isTrue);
      expect(await repository.findById(commit.recordingId), isNull);
      expect(await fixture.database.query('transcription_jobs'), isEmpty);
      expect(await fixture.database.query('meeting_assets'), isEmpty);
    },
  );

  test(
    'recording deletion owns staged, canonical, and journal files',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = RecordingsRepository(database: fixture.appDatabase);
      const sessionId = 'session-owned-files';
      const recordingPath =
          '/data/user/0/app/files/meetings/recordings/complete/session.m4a';
      const stagingPath =
          '/data/user/0/app/files/meetings/recordings/in-progress/'
          'session.m4a.partial';
      const journalPath =
          '/data/user/0/app/files/meetings/journals/'
          'session-owned-files.journal.json';
      final recordingId = await fixture.database
          .insert('recordings', <String, Object?>{
            'file_path': recordingPath,
            'session_id': sessionId,
            'duration_ms': 1000,
            'created_at_ms': 1,
          });
      await fixture.database.insert('recording_sessions', <String, Object?>{
        'session_id': sessionId,
        'state': 'completed',
        'staging_path': stagingPath,
        'canonical_path': recordingPath,
        'duration_ms': 1000,
        'recording_id': recordingId,
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
      await RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      ).addMarker(sessionId: sessionId, positionMs: 500);
      final fileStore = _TrackingFileStore();
      final coordinator = MeetingDeletionCoordinator(
        recordingsRepository: repository,
        fileStore: fileStore,
      );

      final result = await coordinator.permanentlyDelete(recordingId);

      expect(result.completed, isTrue);
      expect(
        fileStore.deletedPaths,
        containsAll(<String>[recordingPath, stagingPath, journalPath]),
      );
      expect(await repository.findById(recordingId), isNull);
      expect(await fixture.database.query('recording_sessions'), isEmpty);
      expect(await fixture.database.query('recording_annotations'), isEmpty);
    },
  );
}

class _RetryFileStore implements MeetingFileStore {
  _RetryFileStore({required this.failingPath});

  final String failingPath;
  bool allowRetry = false;

  @override
  Future<bool> deleteIfPresent(String path) async {
    return path != failingPath || allowRetry;
  }
}

class _TrackingFileStore implements MeetingFileStore {
  final deletedPaths = <String>[];

  @override
  Future<bool> deleteIfPresent(String path) async {
    deletedPaths.add(path);
    return true;
  }
}
