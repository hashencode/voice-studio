import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import 'realtime_recorder_port.dart';
import 'recorder_port.dart';

class AndroidRealtimeRecorderEngine implements RealtimeRecorderPort {
  AndroidRealtimeRecorderEngine()
    : _channel = const MethodChannel(AudioContract.recorderChannel);

  final MethodChannel _channel;

  @override
  Future<void> start() async {
    await _invokeVoid('startRealtime');
  }

  @override
  Future<void> pause() async {
    await _invokeVoid('pauseRealtime');
  }

  @override
  Future<void> resume() async {
    await _invokeVoid('resumeRealtime');
  }

  @override
  Future<RecorderResult> stop() async {
    try {
      final Map<Object?, Object?>? raw = await _channel
          .invokeMapMethod<Object?, Object?>('stopRealtime');
      if (raw == null) {
        throw RecorderException('原生返回为空');
      }

      final String path = (raw['path'] as String?) ?? '';
      final int durationMs = (raw['durationMs'] as int?) ?? 0;
      return RecorderResult(path: path, durationMs: durationMs);
    } on PlatformException catch (e) {
      throw RecorderException(e.message ?? '停止实时录音失败');
    }
  }

  Future<void> _invokeVoid(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on PlatformException catch (e) {
      throw RecorderException(e.message ?? '调用失败: $method');
    }
  }
}
