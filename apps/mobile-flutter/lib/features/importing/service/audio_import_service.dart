import 'package:flutter/services.dart';
import 'package:audio_workflows/audio_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';

import '../../records/repository/recordings_repository.dart';
import '../model/import_candidate.dart';
import 'audio_media_import_port.dart';

class AudioImportException implements Exception {
  const AudioImportException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'AudioImportException($code): $message';
}

class AudioImportOutcome {
  const AudioImportOutcome({
    required this.candidate,
    required this.recordingId,
    required this.inserted,
    this.transcriptionJobId,
  });

  final ImportCandidate candidate;
  final int recordingId;
  final bool inserted;
  final int? transcriptionJobId;
}

class AudioImportService {
  AudioImportService({
    MethodChannel? channel,
    AudioMediaImportPort? mediaImportPort,
    RecordingsRepository? recordingsRepository,
    void Function()? onQueueChanged,
  }) : assert(
         channel == null || mediaImportPort == null,
         'Pass channel or mediaImportPort, not both.',
       ),
       _mediaImportPort =
           mediaImportPort ?? AndroidAudioMediaImportPort(channel: channel),
       _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _onQueueChanged = onQueueChanged {
    _workflow = AudioImportWorkflow(
      commitPort: _RecordingsImportCommitPort(_recordingsRepository),
    );
  }

  final AudioMediaImportPort _mediaImportPort;
  final RecordingsRepository _recordingsRepository;
  final void Function()? _onQueueChanged;
  late final AudioImportWorkflow _workflow;

  bool get isAvailable => _mediaImportPort.isAvailable;

  Stream<void> get sharedMediaAvailable =>
      _mediaImportPort.sharedMediaAvailable;

  Future<bool> hasPendingSharedImport() =>
      _mediaImportPort.hasPendingSharedImport();

  Future<void> cancelImport() => _mediaImportPort.cancelImport();

  Future<AudioImportOutcome?> pickAndImport() async {
    return _importFromPort(_mediaImportPort.pickAudioMedia);
  }

  Future<AudioImportOutcome?> consumeSharedImport() async {
    return _importFromPort(_mediaImportPort.consumeSharedAudioMedia);
  }

  Future<AudioImportOutcome?> _importFromPort(
    Future<AudioMediaCandidate?> Function() select,
  ) async {
    ImportCandidate? candidate;
    try {
      candidate = await select();
      if (candidate == null) return null;
      if (!candidate.isValid) {
        throw const AudioImportException(
          'IMPORT_RESULT_INVALID',
          '系统返回的导入结果不完整',
        );
      }
      final commit = await _workflow.commit(candidate);
      if (!commit.inserted &&
          !candidate.duplicateAsset &&
          candidate.path != commit.existingPath) {
        await _discardBestEffort(candidate.path);
      }
      if (commit.processingJob != null) {
        _onQueueChanged?.call();
      }
      return AudioImportOutcome(
        candidate: candidate,
        recordingId: commit.recordingId,
        inserted: commit.inserted,
        transcriptionJobId: commit.processingJob?.id,
      );
    } on PlatformException catch (error) {
      throw AudioImportException(error.code, error.message ?? '导入媒体失败');
    } on UnsupportedError {
      throw const AudioImportException(
        'IMPORT_CAPABILITY_UNAVAILABLE',
        '当前平台尚未配置真实的音频媒体导入能力',
      );
    } catch (error) {
      if (candidate != null && !candidate.duplicateAsset) {
        await _discardBestEffort(candidate.path);
      }
      if (error is AudioImportException) rethrow;
      throw const AudioImportException(
        'IMPORT_COMMIT_FAILED',
        '导入文件已复制，但写入本地记录失败',
      );
    }
  }

  void dispose() => _mediaImportPort.dispose();

  Future<void> _discardBestEffort(String path) async {
    try {
      await _mediaImportPort.discardImportedMedia(path);
    } catch (_) {
      // Startup reconciliation owns any remnant that cannot be removed here.
    }
  }
}

class _RecordingsImportCommitPort implements AudioImportCommitPort {
  const _RecordingsImportCommitPort(this._repository);

  final RecordingsRepository _repository;

  @override
  Future<AudioImportCommitResult> commit(AudioMediaCandidate candidate) async {
    final commit = await _repository.insertImported(
      filePath: candidate.path,
      displayName: candidate.displayName,
      fingerprintSha256: candidate.fingerprintSha256,
      durationMs: candidate.durationMs,
    );
    return AudioImportCommitResult(
      recordingId: commit.recordingId,
      inserted: commit.inserted,
      existingPath: commit.existingPath,
      processingJob: commit.transcriptionJobId == null
          ? null
          : ProcessingJobReference(
              id: commit.transcriptionJobId!,
              state: ProcessingJobState.queued,
              inputSha256: candidate.fingerprintSha256,
            ),
    );
  }
}
