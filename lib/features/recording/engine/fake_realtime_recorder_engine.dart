import 'dart:async';

import 'realtime_recorder_port.dart';
import 'recorder_port.dart';

class FakeRealtimeRecorderEngine implements RealtimeRecorderPort {
  DateTime? _startedAt;
  int _accumulatedMs = 0;
  bool _isRecording = false;
  bool _isPaused = false;

  @override
  Future<void> start() async {
    if (_isRecording) {
      throw RecorderException('实时录音已经在进行中');
    }
    _startedAt = DateTime.now();
    _accumulatedMs = 0;
    _isRecording = true;
    _isPaused = false;
  }

  @override
  Future<void> pause() async {
    if (!_isRecording || _isPaused || _startedAt == null) {
      throw RecorderException('当前不在可暂停的实时录音状态');
    }
    _accumulatedMs += DateTime.now().difference(_startedAt!).inMilliseconds;
    _startedAt = null;
    _isPaused = true;
  }

  @override
  Future<void> resume() async {
    if (!_isRecording || !_isPaused) {
      throw RecorderException('当前不在可继续的实时录音状态');
    }
    _startedAt = DateTime.now();
    _isPaused = false;
  }

  @override
  Future<RecorderResult> stop() async {
    if (!_isRecording) {
      throw RecorderException('当前没有正在进行的实时录音');
    }
    if (_startedAt != null) {
      _accumulatedMs += DateTime.now().difference(_startedAt!).inMilliseconds;
    }
    final int durationMs = _accumulatedMs;
    _startedAt = null;
    _accumulatedMs = 0;
    _isRecording = false;
    _isPaused = false;

    await Future<void>.delayed(const Duration(milliseconds: 120));
    return RecorderResult(
      path:
          '/tmp/fake-realtime-record-${DateTime.now().millisecondsSinceEpoch}.wav',
      durationMs: durationMs,
    );
  }
}
