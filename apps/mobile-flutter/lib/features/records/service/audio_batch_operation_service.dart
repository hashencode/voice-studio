import 'dart:convert';

import 'package:path/path.dart' as p;

import '../../audios/service/audio_export_service.dart';
import '../../shared/service/ephemeral_share_artifact_service.dart';
import '../../transcription/repository/transcript_segments_repository.dart';
import '../../transcription/repository/transcription_jobs_repository.dart';
import '../model/recording_entity.dart';
import '../repository/recordings_repository.dart';
import 'audio_deletion_coordinator.dart';

typedef RetryRecordings =
    Future<Map<int, TranscriptionRecordingRetryResult>> Function(
      Iterable<int> recordingIds,
    );

enum AudioBatchItemStatus { succeeded, skipped, failed }

class AudioBatchItemResult {
  const AudioBatchItemResult({
    required this.recordingId,
    required this.status,
    required this.reason,
    this.entryName,
  });

  final int recordingId;
  final AudioBatchItemStatus status;
  final String reason;
  final String? entryName;
}

class AudioBatchOperationResult {
  const AudioBatchOperationResult({required this.items});

  final List<AudioBatchItemResult> items;

  AudioBatchItemResult forRecording(int recordingId) {
    return items.singleWhere((item) => item.recordingId == recordingId);
  }

  int get succeededCount => items
      .where((item) => item.status == AudioBatchItemStatus.succeeded)
      .length;

  int get skippedCount =>
      items.where((item) => item.status == AudioBatchItemStatus.skipped).length;

  int get failedCount =>
      items.where((item) => item.status == AudioBatchItemStatus.failed).length;
}

class AudioBatchExportResult extends AudioBatchOperationResult {
  const AudioBatchExportResult({
    required super.items,
    required this.artifact,
    required this.format,
  });

  final EphemeralShareArtifact? artifact;
  final AudioExportFormat format;
}

class AudioBatchOperationService {
  AudioBatchOperationService({
    RecordingsRepository? recordingsRepository,
    TranscriptionJobsRepository? transcriptionJobsRepository,
    TranscriptSegmentsRepository? transcriptSegmentsRepository,
    AudioDeletionCoordinator? audioDeletionCoordinator,
    AudioExportService? audioExportService,
    EphemeralShareArtifactService? ephemeralShareArtifactService,
    RetryRecordings? retryRecordings,
  }) : _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _transcriptionJobsRepository =
           transcriptionJobsRepository ?? TranscriptionJobsRepository(),
       _transcriptSegmentsRepository =
           transcriptSegmentsRepository ?? TranscriptSegmentsRepository(),
       _audioDeletionCoordinator =
           audioDeletionCoordinator ??
           AudioDeletionCoordinator(recordingsRepository: recordingsRepository),
       _audioExportService =
           audioExportService ??
           AudioExportService(recordingsRepository: recordingsRepository),
       _ephemeralShareArtifactService =
           ephemeralShareArtifactService ?? EphemeralShareArtifactService(),
       _retryRecordings = retryRecordings;

  final RecordingsRepository _recordingsRepository;
  final TranscriptionJobsRepository _transcriptionJobsRepository;
  final TranscriptSegmentsRepository _transcriptSegmentsRepository;
  final AudioDeletionCoordinator _audioDeletionCoordinator;
  final AudioExportService _audioExportService;
  final EphemeralShareArtifactService _ephemeralShareArtifactService;
  final RetryRecordings? _retryRecordings;

  Future<AudioBatchOperationResult> move(
    Iterable<int> recordingIds, {
    required String targetGroup,
  }) async {
    final group = targetGroup.trim();
    if (group.isEmpty) {
      throw ArgumentError.value(
        targetGroup,
        'targetGroup',
        'must not be empty',
      );
    }
    final ids = _stableIds(recordingIds);
    final recordings = await _recordingsRepository.findByIds(ids);
    final results = <AudioBatchItemResult>[];
    for (final id in ids) {
      final recording = recordings[id];
      if (recording == null) {
        results.add(_skipped(id, 'recording_not_found'));
      } else if (recording.deletedAtMs != null) {
        results.add(_skipped(id, 'recording_deleted'));
      } else {
        try {
          await _recordingsRepository.updateGroupName(id: id, groupName: group);
          results.add(_succeeded(id, 'moved'));
        } catch (_) {
          results.add(_failed(id, 'move_failed'));
        }
      }
    }
    return AudioBatchOperationResult(items: List.unmodifiable(results));
  }

  Future<AudioBatchOperationResult> softDelete(
    Iterable<int> recordingIds,
  ) async {
    final ids = _stableIds(recordingIds);
    final recordings = await _recordingsRepository.findByIds(ids);
    final results = <AudioBatchItemResult>[];
    for (final id in ids) {
      final recording = recordings[id];
      if (recording == null) {
        results.add(_skipped(id, 'recording_not_found'));
      } else if (recording.deletedAtMs != null) {
        results.add(_skipped(id, 'already_deleted'));
      } else {
        try {
          await _recordingsRepository.softDeleteById(id);
          results.add(_succeeded(id, 'soft_deleted'));
        } catch (_) {
          results.add(_failed(id, 'soft_delete_failed'));
        }
      }
    }
    return AudioBatchOperationResult(items: List.unmodifiable(results));
  }

  Future<AudioBatchOperationResult> permanentlyDelete(
    Iterable<int> recordingIds,
  ) async {
    final ids = _stableIds(recordingIds);
    final recordings = await _recordingsRepository.findByIds(ids);
    final results = <AudioBatchItemResult>[];
    for (final id in ids) {
      final recording = recordings[id];
      if (recording == null) {
        results.add(_skipped(id, 'recording_not_found'));
      } else if (recording.deletedAtMs == null) {
        results.add(_skipped(id, 'not_recently_deleted'));
      } else {
        try {
          final deletion = await _audioDeletionCoordinator.permanentlyDelete(
            id,
          );
          results.add(
            deletion.completed
                ? _succeeded(id, 'permanently_deleted')
                : _failed(id, 'deletion_pending'),
          );
        } catch (_) {
          results.add(_failed(id, 'deletion_pending'));
        }
      }
    }
    return AudioBatchOperationResult(items: List.unmodifiable(results));
  }

  Future<AudioBatchOperationResult> retry(Iterable<int> recordingIds) async {
    final ids = _stableIds(recordingIds);
    final recordings = await _recordingsRepository.findByIds(ids);
    final activeIds = ids
        .where(
          (id) => recordings[id] != null && recordings[id]!.deletedAtMs == null,
        )
        .toList(growable: false);
    Map<int, TranscriptionRecordingRetryResult> retryResults =
        const <int, TranscriptionRecordingRetryResult>{};
    if (activeIds.isNotEmpty) {
      final retryRecordings =
          _retryRecordings ??
          _transcriptionJobsRepository.retryLatestForRecordingIds;
      try {
        retryResults = await retryRecordings(activeIds);
      } catch (_) {
        retryResults = const <int, TranscriptionRecordingRetryResult>{};
      }
    }
    final results = <AudioBatchItemResult>[];
    for (final id in ids) {
      final recording = recordings[id];
      if (recording == null) {
        results.add(_skipped(id, 'recording_not_found'));
        continue;
      }
      if (recording.deletedAtMs != null) {
        results.add(_skipped(id, 'recording_deleted'));
        continue;
      }
      final retry = retryResults[id];
      results.add(switch (retry?.status) {
        TranscriptionRecordingRetryStatus.retried => _succeeded(id, 'retried'),
        TranscriptionRecordingRetryStatus.jobNotFound => _skipped(
          id,
          'job_not_found',
        ),
        TranscriptionRecordingRetryStatus.jobNotRetryable => _skipped(
          id,
          'job_not_retryable',
        ),
        null => _failed(id, 'retry_failed'),
      });
    }
    return AudioBatchOperationResult(items: List.unmodifiable(results));
  }

  Future<AudioBatchExportResult> export(
    Iterable<int> recordingIds, {
    required AudioExportFormat format,
  }) async {
    final ids = _stableIds(recordingIds);
    final recordings = await _recordingsRepository.findByIds(ids);
    final entries = <EphemeralArchiveEntry>[];
    final preliminary = <int, AudioBatchItemResult>{};
    for (final id in ids) {
      final recording = recordings[id];
      if (recording == null) {
        preliminary[id] = _skipped(id, 'recording_not_found');
        continue;
      }
      if (recording.deletedAtMs != null) {
        preliminary[id] = _skipped(id, 'recording_deleted');
        continue;
      }
      final title = _recordingTitle(recording);
      final entryName = _entryName(title: title, id: id, format: format);
      entries.add(
        EphemeralArchiveEntry(
          id: id.toString(),
          name: entryName,
          write: (target) async {
            final segments = await _transcriptSegmentsRepository
                .listForRecordingPath(recording.filePath);
            if (segments.isEmpty) {
              throw const EphemeralArchiveEntryException(
                'transcript_unavailable',
              );
            }
            await _audioExportService.exportToFile(
              destination: target,
              title: title,
              segments: segments,
              format: format,
            );
          },
        ),
      );
    }

    if (entries.isEmpty) {
      return AudioBatchExportResult(
        items: List.unmodifiable(
          ids.map((id) => preliminary[id] ?? _failed(id, 'export_failed')),
        ),
        artifact: null,
        format: format,
      );
    }

    late EphemeralArchiveBuildResult build;
    try {
      build = await _ephemeralShareArtifactService.buildZip(
        baseName: 'audio-transcripts',
        entries: entries,
        buildManifest: (entryResults) => _manifestJson(
          format: format,
          ids: ids,
          recordings: recordings,
          preliminary: preliminary,
          entryResults: entryResults,
        ),
      );
    } catch (_) {
      return AudioBatchExportResult(
        items: List.unmodifiable(
          ids.map((id) => preliminary[id] ?? _failed(id, 'archive_failed')),
        ),
        artifact: null,
        format: format,
      );
    }

    final byId = <int, EphemeralArchiveEntryResult>{
      for (final entry in build.entries) int.parse(entry.id): entry,
    };
    final results = ids
        .map((id) {
          final fixed = preliminary[id];
          if (fixed != null) return fixed;
          final entry = byId[id];
          if (entry == null) return _failed(id, 'export_failed');
          if (entry.succeeded) {
            return AudioBatchItemResult(
              recordingId: id,
              status: AudioBatchItemStatus.succeeded,
              reason: 'exported',
              entryName: entry.name,
            );
          }
          if (entry.errorCode == 'transcript_unavailable') {
            return _skipped(id, 'transcript_unavailable');
          }
          return _failed(id, entry.errorCode ?? 'export_failed');
        })
        .toList(growable: false);
    return AudioBatchExportResult(
      items: List.unmodifiable(results),
      artifact: build.artifact,
      format: format,
    );
  }

  Future<EphemeralShareReceipt> shareExport(AudioBatchExportResult result) {
    final artifact = result.artifact;
    if (artifact == null) {
      throw StateError('没有可分享的批量导出文件');
    }
    return _ephemeralShareArtifactService.share(artifact);
  }

  Future<int> cleanupStaleArtifacts() {
    return _ephemeralShareArtifactService.cleanupStale();
  }

  List<int> _stableIds(Iterable<int> recordingIds) {
    final ids = <int>[];
    final seen = <int>{};
    for (final id in recordingIds) {
      if (id > 0 && seen.add(id)) ids.add(id);
    }
    return ids;
  }

  String _entryName({
    required String title,
    required int id,
    required AudioExportFormat format,
  }) {
    final extension = switch (format) {
      AudioExportFormat.text => 'txt',
      AudioExportFormat.markdown => 'md',
      AudioExportFormat.json => 'json',
      AudioExportFormat.srt => 'srt',
      AudioExportFormat.vtt => 'vtt',
    };
    final safeTitle = EphemeralShareArtifactService.normalizeSafeBasename(
      title.replaceAll('/', '_').replaceAll(r'\', '_'),
    );
    final boundedTitle = safeTitle.length <= 90
        ? safeTitle
        : safeTitle.substring(0, 90);
    return EphemeralShareArtifactService.normalizeSafeBasename(
      '$boundedTitle-$id.$extension',
    );
  }

  String _manifestJson({
    required AudioExportFormat format,
    required List<int> ids,
    required Map<int, RecordingEntity> recordings,
    required Map<int, AudioBatchItemResult> preliminary,
    required List<EphemeralArchiveEntryResult> entryResults,
  }) {
    final entryById = <int, EphemeralArchiveEntryResult>{
      for (final entry in entryResults) int.parse(entry.id): entry,
    };
    return const JsonEncoder.withIndent('  ').convert(<String, Object?>{
      'schemaVersion': 1,
      'format': format.name,
      'items': ids
          .map((id) {
            final recording = recordings[id];
            final fixed = preliminary[id];
            final entry = entryById[id];
            return <String, Object?>{
              'recordingId': id,
              if (recording != null) 'title': _recordingTitle(recording),
              'status': fixed != null
                  ? fixed.status.name
                  : entry?.succeeded == true
                  ? AudioBatchItemStatus.succeeded.name
                  : entry?.errorCode == 'transcript_unavailable'
                  ? AudioBatchItemStatus.skipped.name
                  : AudioBatchItemStatus.failed.name,
              'reason':
                  fixed?.reason ??
                  (entry?.succeeded == true
                      ? 'exported'
                      : entry?.errorCode ?? 'export_failed'),
              if (entry?.succeeded == true) 'entry': entry!.name,
            };
          })
          .toList(growable: false),
    });
  }
}

AudioBatchItemResult _succeeded(int id, String reason) {
  return AudioBatchItemResult(
    recordingId: id,
    status: AudioBatchItemStatus.succeeded,
    reason: reason,
  );
}

AudioBatchItemResult _skipped(int id, String reason) {
  return AudioBatchItemResult(
    recordingId: id,
    status: AudioBatchItemStatus.skipped,
    reason: reason,
  );
}

AudioBatchItemResult _failed(int id, String reason) {
  return AudioBatchItemResult(
    recordingId: id,
    status: AudioBatchItemStatus.failed,
    reason: reason,
  );
}

String _recordingTitle(RecordingEntity recording) {
  final displayName = recording.displayName?.trim() ?? '';
  if (displayName.isNotEmpty) return displayName;
  final pathTitle = p.basenameWithoutExtension(recording.filePath).trim();
  return pathTitle.isNotEmpty ? pathTitle : 'audio-${recording.id}';
}
