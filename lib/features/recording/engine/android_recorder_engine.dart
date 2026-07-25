import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import 'recorder_port.dart';

class AndroidRecorderEngine implements RecorderPort {
  AndroidRecorderEngine({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(AudioContract.recorderChannel);

  final MethodChannel _channel;

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) async {
    final raw = await _invokeMap('start', <String, Object?>{
      'sessionId': sessionId,
    });
    return RecordingSessionSnapshot.fromMap(raw);
  }

  @override
  Future<RecordingSessionSnapshot> pause() async {
    return RecordingSessionSnapshot.fromMap(await _invokeMap('pause'));
  }

  @override
  Future<RecordingSessionSnapshot> resume() async {
    return RecordingSessionSnapshot.fromMap(await _invokeMap('resume'));
  }

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) async {
    final raw = await _invokeMap('stop', <String, Object?>{'reason': reason});
    return RecorderResult.fromMap(raw);
  }

  @override
  Future<RecordingSessionSnapshot> getState() async {
    return RecordingSessionSnapshot.fromMap(
      await _invokeMap('getRecordingState'),
    );
  }

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async {
    try {
      final raw = await _channel.invokeListMethod<Object?>(
        'listRecordingInputDevices',
      );
      return (raw ?? const <Object?>[])
          .whereType<Map<Object?, Object?>>()
          .map(RecordingInputDevice.fromMap)
          .toList(growable: false);
    } on PlatformException catch (error) {
      throw RecorderException(error.message ?? '读取录音输入设备失败', code: error.code);
    }
  }

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) async {
    final raw = await _invokeMap(
      'selectRecordingInputDevice',
      <String, Object?>{'deviceId': deviceId},
    );
    return RecordingSessionSnapshot.fromMap(raw);
  }

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async {
    try {
      final raw = await _channel.invokeListMethod<Object?>(
        'listRecordingRecoveries',
      );
      return (raw ?? const <Object?>[])
          .whereType<Map<Object?, Object?>>()
          .map(RecordingRecoveryCandidate.fromMap)
          .toList(growable: false);
    } on PlatformException catch (error) {
      throw RecorderException(error.message ?? '检查待恢复录音失败', code: error.code);
    }
  }

  @override
  Future<RecorderResult> recover(String sessionId) async {
    return RecorderResult.fromMap(
      await _invokeMap('recoverRecording', <String, Object?>{
        'sessionId': sessionId,
      }),
    );
  }

  @override
  Future<void> discardRecovery(String sessionId) async {
    try {
      await _channel.invokeMethod<void>(
        'discardRecordingRecovery',
        <String, Object?>{'sessionId': sessionId},
      );
    } on PlatformException catch (error) {
      throw RecorderException(error.message ?? '清理临时录音失败', code: error.code);
    }
  }

  Future<Map<Object?, Object?>> _invokeMap(
    String method, [
    Map<String, Object?>? arguments,
  ]) async {
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(
        method,
        arguments,
      );
      if (raw == null) {
        throw RecorderException('原生录音服务返回为空');
      }
      return raw;
    } on PlatformException catch (error) {
      throw RecorderException(error.message ?? '录音操作失败', code: error.code);
    }
  }
}
