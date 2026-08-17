import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import '../repository/recordings_repository.dart';

class AudioShareReceipt {
  const AudioShareReceipt({required this.exportPath, required this.readOnly});

  final String exportPath;
  final bool readOnly;
}

class AudioShareService {
  AudioShareService({
    MethodChannel? channel,
    RecordingsRepository? recordingsRepository,
  }) : _channel = channel ?? const MethodChannel(AudioContract.recorderChannel),
       _recordingsRepository = recordingsRepository ?? RecordingsRepository();

  final MethodChannel _channel;
  final RecordingsRepository _recordingsRepository;

  Future<AudioShareReceipt> share({
    required int recordingId,
    required String path,
    required String displayName,
  }) async {
    String? preparedExportPath;
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(
        'shareAudioFile',
        <String, Object?>{'path': path, 'displayName': displayName},
      );
      final exportPath = raw?['exportPath'] as String? ?? '';
      preparedExportPath = exportPath.isEmpty ? null : exportPath;
      final readOnly = raw?['readOnly'] as bool? ?? false;
      if (exportPath.isEmpty || !readOnly) {
        throw PlatformException(
          code: 'SHARE_RESULT_INVALID',
          message: '系统分享结果不完整',
        );
      }
      await _recordingsRepository.registerOwnedAsset(
        recordingId: recordingId,
        path: exportPath,
        kind: 'share_export',
      );
      return AudioShareReceipt(exportPath: exportPath, readOnly: true);
    } catch (error) {
      if (preparedExportPath != null) {
        await _discardBestEffort(preparedExportPath);
      }
      if (error is PlatformException) {
        throw StateError(error.message ?? '无法打开系统分享');
      }
      throw StateError('分享文件登记失败');
    }
  }

  Future<void> _discardBestEffort(String path) async {
    try {
      await _channel.invokeMethod<void>('discardShareExport', <String, Object?>{
        'path': path,
      });
    } catch (_) {
      // A retained export remains owned by the app-private export directory.
    }
  }
}
