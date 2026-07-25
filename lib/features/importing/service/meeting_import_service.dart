import 'dart:async';

import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import '../../records/repository/recordings_repository.dart';
import '../model/import_candidate.dart';

class MeetingImportException implements Exception {
  const MeetingImportException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'MeetingImportException($code): $message';
}

class MeetingImportOutcome {
  const MeetingImportOutcome({
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

class MeetingImportService {
  MeetingImportService({
    MethodChannel? channel,
    RecordingsRepository? recordingsRepository,
    void Function()? onQueueChanged,
  }) : _channel = channel ?? const MethodChannel(AudioContract.recorderChannel),
       _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _onQueueChanged = onQueueChanged {
    _channel.setMethodCallHandler(_handleNativeMethod);
  }

  final MethodChannel _channel;
  final RecordingsRepository _recordingsRepository;
  final void Function()? _onQueueChanged;
  final StreamController<void> _sharedMediaAvailableController =
      StreamController<void>.broadcast();

  Stream<void> get sharedMediaAvailable =>
      _sharedMediaAvailableController.stream;

  Future<bool> hasPendingSharedImport() async {
    try {
      return await _channel.invokeMethod<bool>(
            'hasPendingSharedMeetingMedia',
          ) ??
          false;
    } on MissingPluginException {
      return false;
    }
  }

  Future<void> cancelImport() async {
    try {
      await _channel.invokeMethod<void>('cancelMeetingImport');
    } on PlatformException {
      // The import result remains authoritative if native cancellation races
      // with a copy that has already completed.
    }
  }

  Future<MeetingImportOutcome?> pickAndImport() async {
    return _importFromNative('pickMeetingMedia');
  }

  Future<MeetingImportOutcome?> consumeSharedImport() async {
    return _importFromNative('consumeSharedMeetingMedia');
  }

  Future<MeetingImportOutcome?> _importFromNative(String method) async {
    ImportCandidate? candidate;
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(method);
      if (raw == null) return null;
      candidate = ImportCandidate.fromMap(raw);
      if (candidate.path.isEmpty ||
          candidate.fingerprintSha256.isEmpty ||
          candidate.durationMs <= 0) {
        throw const MeetingImportException(
          'IMPORT_RESULT_INVALID',
          '系统返回的导入结果不完整',
        );
      }
      final commit = await _recordingsRepository.insertImported(
        filePath: candidate.path,
        displayName: candidate.displayName,
        fingerprintSha256: candidate.fingerprintSha256,
        durationMs: candidate.durationMs,
      );
      if (!commit.inserted &&
          !candidate.duplicateAsset &&
          candidate.path != commit.existingPath) {
        await _discardBestEffort(candidate.path);
      }
      if (commit.transcriptionJobId != null) {
        _onQueueChanged?.call();
      }
      return MeetingImportOutcome(
        candidate: candidate,
        recordingId: commit.recordingId,
        inserted: commit.inserted,
        transcriptionJobId: commit.transcriptionJobId,
      );
    } on PlatformException catch (error) {
      throw MeetingImportException(error.code, error.message ?? '导入媒体失败');
    } catch (error) {
      if (candidate != null && !candidate.duplicateAsset) {
        await _discardBestEffort(candidate.path);
      }
      if (error is MeetingImportException) rethrow;
      throw const MeetingImportException(
        'IMPORT_COMMIT_FAILED',
        '导入文件已复制，但写入本地记录失败',
      );
    }
  }

  Future<Object?> _handleNativeMethod(MethodCall call) async {
    if (call.method == 'sharedMeetingMediaAvailable' &&
        !_sharedMediaAvailableController.isClosed) {
      _sharedMediaAvailableController.add(null);
    }
    return null;
  }

  void dispose() {
    _channel.setMethodCallHandler(null);
    _sharedMediaAvailableController.close();
  }

  Future<void> _discardBestEffort(String path) async {
    try {
      await _channel.invokeMethod<void>(
        'discardImportedMedia',
        <String, Object?>{'path': path},
      );
    } catch (_) {
      // Startup reconciliation owns any remnant that cannot be removed here.
    }
  }
}
