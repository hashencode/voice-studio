import 'dart:async';

import 'recorder_port.dart';

class FakeRecorderEngine implements RecorderPort {
  DateTime? _startedAt;
  int _accumulatedMs = 0;
  String _sessionId = '';
  String _state = 'idle';
  String? _stopReason;
  final List<RecordingRecoveryCandidate> _recoveries =
      <RecordingRecoveryCandidate>[];
  int inputAmplitude = 0;
  RecordingInputStatus inputStatus = RecordingInputStatus.silent;
  RecordingInputDeviceType inputDeviceType = RecordingInputDeviceType.builtIn;
  String? inputDeviceName;
  bool inputAvailable = true;
  int getStateCallCount = 0;
  List<RecordingInputDevice> inputDevices = const <RecordingInputDevice>[
    RecordingInputDevice(
      id: 1,
      name: '手机麦克风',
      type: RecordingInputDeviceType.builtIn,
      canSelect: true,
    ),
  ];
  int? preferredInputDeviceId;
  RecordingInputFallbackReason inputFallbackReason =
      RecordingInputFallbackReason.none;

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) async {
    if (_state == 'recording' || _state == 'paused') {
      return getState();
    }
    _sessionId = sessionId ?? 'fake-${DateTime.now().microsecondsSinceEpoch}';
    _accumulatedMs = 0;
    _startedAt = DateTime.now();
    _state = 'recording';
    _stopReason = null;
    final bool preferredInputUnavailable =
        preferredInputDeviceId != null &&
        !inputDevices.any((device) => device.id == preferredInputDeviceId);
    if (preferredInputUnavailable) {
      preferredInputDeviceId = null;
      inputFallbackReason = RecordingInputFallbackReason.deviceDisconnected;
    } else {
      inputFallbackReason = RecordingInputFallbackReason.none;
    }
    return getState();
  }

  @override
  Future<RecordingSessionSnapshot> pause() async {
    if (_state != 'recording' || _startedAt == null) {
      throw RecorderException('当前不在录音，无法暂停');
    }
    _accumulatedMs += DateTime.now().difference(_startedAt!).inMilliseconds;
    _startedAt = null;
    _state = 'paused';
    return getState();
  }

  @override
  Future<RecordingSessionSnapshot> resume() async {
    if (_state != 'paused') {
      throw RecorderException('当前不在暂停状态');
    }
    _startedAt = DateTime.now();
    _state = 'recording';
    return getState();
  }

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) async {
    if (_state != 'recording' && _state != 'paused') {
      throw RecorderException('当前没有正在进行的录音');
    }
    if (_startedAt != null) {
      _accumulatedMs += DateTime.now().difference(_startedAt!).inMilliseconds;
    }
    final result = RecorderResult(
      sessionId: _sessionId,
      path: '/tmp/fake-record-$_sessionId.m4a',
      durationMs: _accumulatedMs,
      stopReason: reason,
    );
    _startedAt = null;
    _accumulatedMs = 0;
    _state = 'completed';
    _stopReason = reason;
    return result;
  }

  @override
  Future<RecordingSessionSnapshot> getState() async {
    getStateCallCount += 1;
    final RecordingInputDevice? selectedDevice = preferredInputDeviceId == null
        ? null
        : inputDevices
              .where((device) => device.id == preferredInputDeviceId)
              .firstOrNull;
    final RecordingInputDevice? automaticDevice = inputDevices
        .where((device) => device.type == inputDeviceType)
        .firstOrNull;
    final activeMs = _startedAt == null
        ? 0
        : DateTime.now().difference(_startedAt!).inMilliseconds;
    return RecordingSessionSnapshot(
      sessionId: _sessionId,
      state: _state,
      durationMs: _accumulatedMs + activeMs,
      canonicalPath: _state == 'completed'
          ? '/tmp/fake-record-$_sessionId.m4a'
          : null,
      stopReason: _stopReason,
      inputAmplitude: _state == 'recording' ? inputAmplitude : 0,
      inputStatus: _state == 'paused'
          ? RecordingInputStatus.paused
          : _state == 'recording'
          ? inputStatus
          : RecordingInputStatus.unknown,
      inputDeviceType: _state == 'recording'
          ? selectedDevice?.type ?? inputDeviceType
          : RecordingInputDeviceType.unknown,
      inputAvailable: _state == 'recording' && inputAvailable,
      inputDeviceId: _state == 'recording'
          ? selectedDevice?.id ?? automaticDevice?.id
          : null,
      inputDeviceName: _state == 'recording'
          ? selectedDevice?.name ?? inputDeviceName ?? automaticDevice?.name
          : null,
      preferredInputDeviceId: preferredInputDeviceId,
      inputFallbackReason: inputFallbackReason,
      inputSelectionSupported: inputDevices.any((device) => device.canSelect),
    );
  }

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      List<RecordingInputDevice>.unmodifiable(inputDevices);

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) async {
    if (deviceId != null) {
      final device = inputDevices
          .where((candidate) => candidate.id == deviceId)
          .firstOrNull;
      if (device == null) {
        throw RecorderException('所选麦克风已断开', code: 'INPUT_DEVICE_UNAVAILABLE');
      }
      if (!device.canSelect) {
        throw RecorderException(
          '当前系统仅支持自动选择录音输入',
          code: 'INPUT_SELECTION_UNSUPPORTED',
        );
      }
    }
    preferredInputDeviceId = deviceId;
    inputFallbackReason = RecordingInputFallbackReason.none;
    return getState();
  }

  void simulatePreferredInputDisconnect({bool fallbackSucceeded = true}) {
    if (preferredInputDeviceId == null) return;
    preferredInputDeviceId = null;
    if (!fallbackSucceeded) {
      if (_startedAt != null) {
        _accumulatedMs += DateTime.now().difference(_startedAt!).inMilliseconds;
      }
      _startedAt = null;
      _state = 'completed';
      _stopReason = 'input_device_lost';
      inputFallbackReason = RecordingInputFallbackReason.none;
      return;
    }
    inputFallbackReason = RecordingInputFallbackReason.deviceDisconnected;
    inputDeviceType = RecordingInputDeviceType.builtIn;
    inputDeviceName = '手机麦克风';
  }

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async =>
      List<RecordingRecoveryCandidate>.unmodifiable(_recoveries);

  @override
  Future<RecorderResult> recover(String sessionId) async {
    final candidate = _recoveries.firstWhere(
      (item) => item.sessionId == sessionId && item.canRecover,
    );
    _recoveries.remove(candidate);
    return RecorderResult(
      sessionId: sessionId,
      path: candidate.canonicalPath ?? '/tmp/$sessionId.m4a',
      durationMs: candidate.durationMs,
      stopReason: 'recovered',
    );
  }

  @override
  Future<void> discardRecovery(String sessionId) async {
    _recoveries.removeWhere((item) => item.sessionId == sessionId);
  }
}
