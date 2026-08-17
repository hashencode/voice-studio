import 'dart:io';

import 'package:path/path.dart' as p;

import '../model/recording_entity.dart';
import '../repository/recordings_repository.dart';

abstract interface class AudioFileStore {
  Future<bool> deleteIfPresent(String path);
}

class LocalAudioFileStore implements AudioFileStore {
  @override
  Future<bool> deleteIfPresent(String path) async {
    final normalized = p.normalize(File(path).absolute.path);
    final managedFilesMarker =
        '${Platform.pathSeparator}files${Platform.pathSeparator}'
        'audios${Platform.pathSeparator}';
    final cacheExportRoot = p.normalize(
      p.join(Directory.systemTemp.path, 'voice2text', 'audios', 'exports'),
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

class AudioDeletionResult {
  const AudioDeletionResult({required this.completed, this.failedPath});

  final bool completed;
  final String? failedPath;
}

class AudioDeletionCoordinator {
  AudioDeletionCoordinator({
    RecordingsRepository? recordingsRepository,
    AudioFileStore? fileStore,
  }) : _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _fileStore = fileStore ?? LocalAudioFileStore();

  final RecordingsRepository _recordingsRepository;
  final AudioFileStore _fileStore;

  Future<AudioDeletionResult> permanentlyDelete(int recordingId) async {
    final RecordingEntity? recording = await _recordingsRepository.findById(
      recordingId,
    );
    if (recording == null) {
      return const AudioDeletionResult(completed: true);
    }
    await _recordingsRepository.markDeletionPending(recordingId);
    final paths = await _recordingsRepository.listOwnedAssetPaths(recordingId);
    for (final path in paths) {
      if (!await _fileStore.deleteIfPresent(path)) {
        return AudioDeletionResult(completed: false, failedPath: path);
      }
    }
    await _recordingsRepository.deleteAudioGraph(
      recordingId: recordingId,
      recordingPath: recording.filePath,
    );
    return const AudioDeletionResult(completed: true);
  }
}
