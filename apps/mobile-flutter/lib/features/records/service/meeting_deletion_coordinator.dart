import 'dart:io';

import 'package:path/path.dart' as p;

import '../model/recording_entity.dart';
import '../repository/recordings_repository.dart';

abstract interface class MeetingFileStore {
  Future<bool> deleteIfPresent(String path);
}

class LocalMeetingFileStore implements MeetingFileStore {
  @override
  Future<bool> deleteIfPresent(String path) async {
    final normalized = p.normalize(File(path).absolute.path);
    final managedFilesMarker =
        '${Platform.pathSeparator}files${Platform.pathSeparator}'
        'meetings${Platform.pathSeparator}';
    final cacheExportRoot = p.normalize(
      p.join(Directory.systemTemp.path, 'voice2text', 'meetings', 'exports'),
    );
    final inManagedFiles = normalized.contains(managedFilesMarker);
    final inManagedExportCache =
        normalized == cacheExportRoot ||
        p.isWithin(cacheExportRoot, normalized);
    if (!inManagedFiles && !inManagedExportCache) {
      return false;
    }
    final file = File(normalized);
    if (!await file.exists()) return true;
    try {
      await file.delete();
      return true;
    } catch (_) {
      return false;
    }
  }
}

class MeetingDeletionResult {
  const MeetingDeletionResult({required this.completed, this.failedPath});

  final bool completed;
  final String? failedPath;
}

class MeetingDeletionCoordinator {
  MeetingDeletionCoordinator({
    RecordingsRepository? recordingsRepository,
    MeetingFileStore? fileStore,
  }) : _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _fileStore = fileStore ?? LocalMeetingFileStore();

  final RecordingsRepository _recordingsRepository;
  final MeetingFileStore _fileStore;

  Future<MeetingDeletionResult> permanentlyDelete(int recordingId) async {
    final RecordingEntity? recording = await _recordingsRepository.findById(
      recordingId,
    );
    if (recording == null) {
      return const MeetingDeletionResult(completed: true);
    }
    await _recordingsRepository.markDeletionPending(recordingId);
    final paths = await _recordingsRepository.listOwnedAssetPaths(recordingId);
    for (final path in paths) {
      if (!await _fileStore.deleteIfPresent(path)) {
        return MeetingDeletionResult(completed: false, failedPath: path);
      }
    }
    await _recordingsRepository.deleteMeetingGraph(
      recordingId: recordingId,
      recordingPath: recording.filePath,
    );
    return const MeetingDeletionResult(completed: true);
  }
}
