import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../../settings/repository/app_settings_repository.dart';
import '../../transcription/repository/transcription_jobs_repository.dart';
import '../../transcription/service/transcription_port.dart';
import '../../transcription/service/transcription_queue_coordinator.dart';
import '../engine/recorder_port.dart';
import '../model/recording_phase.dart';
import '../repository/recording_sessions_repository.dart';
import '../service/recording_recovery_coordinator.dart';
import '../services/microphone_permission_service.dart';

class RecordingController extends ChangeNotifier {
  RecordingController({
    required MicrophonePermissionService permissionService,
    required RecorderPort recorder,
    required RecordingSessionsRepository recordingSessionsRepository,
    required RecordingRecoveryCoordinator recoveryCoordinator,
    required TranscriptionJobsRepository transcriptionJobsRepository,
    required TranscriptionPort transcriptionService,
    required AppSettingsRepository appSettingsRepository,
    TranscriptionQueueCoordinator? transcriptionQueueCoordinator,
  }) : _permissionService = permissionService,
       _recorder = recorder,
       _recordingSessionsRepository = recordingSessionsRepository,
       _recoveryCoordinator = recoveryCoordinator,
       _transcriptionQueueCoordinator = transcriptionQueueCoordinator,
       _appSettingsRepository = appSettingsRepository;

  final MicrophonePermissionService _permissionService;
  final RecorderPort _recorder;
  final RecordingSessionsRepository _recordingSessionsRepository;
  final RecordingRecoveryCoordinator _recoveryCoordinator;
  final TranscriptionQueueCoordinator? _transcriptionQueueCoordinator;
  final AppSettingsRepository _appSettingsRepository;

  RecordingPhase _phase = RecordingPhase.idle;
  String? _errorMessage;
  int _elapsedMs = 0;
  String? _activeModelId;
  bool _autoTranscribeEnabled = true;
  bool _permissionDenied = false;
  String? _activeSessionId;
  List<RecordingRecoveryCandidate> _recoveryCandidates =
      const <RecordingRecoveryCandidate>[];
  Timer? _ticker;
  Timer? _telemetryTicker;
  bool _telemetryPollInFlight = false;
  RecordingInputStatus _inputStatus = RecordingInputStatus.unknown;
  RecordingInputDeviceType _inputDeviceType = RecordingInputDeviceType.unknown;
  int? _inputDeviceId;
  String? _inputDeviceName;
  int? _preferredInputDeviceId;
  bool _inputSelectionSupported = false;
  String? _inputRouteNotice;
  List<RecordingInputDevice> _inputDevices = const <RecordingInputDevice>[];
  List<double> _inputAmplitudeWindow = List<double>.filled(
    inputAmplitudeWindowSize,
    0,
  );

  RecordingPhase get phase => _phase;
  String? get errorMessage => _errorMessage;
  int get elapsedMs => _elapsedMs;
  String? get activeModelId => _activeModelId;
  bool get autoTranscribeEnabled => _autoTranscribeEnabled;
  bool get permissionDenied => _permissionDenied;
  String? get activeSessionId => _activeSessionId;
  List<RecordingRecoveryCandidate> get recoveryCandidates =>
      _recoveryCandidates;
  RecordingInputStatus get inputStatus => _inputStatus;
  RecordingInputDeviceType get inputDeviceType => _inputDeviceType;
  int? get inputDeviceId => _inputDeviceId;
  String? get inputDeviceName => _inputDeviceName;
  int? get preferredInputDeviceId => _preferredInputDeviceId;
  bool get inputSelectionSupported => _inputSelectionSupported;
  String? get inputRouteNotice => _inputRouteNotice;
  List<RecordingInputDevice> get inputDevices =>
      List<RecordingInputDevice>.unmodifiable(_inputDevices);
  String get preferredInputDeviceName {
    final int? preferredId = _preferredInputDeviceId;
    if (preferredId == null) return '系统自动选择';
    return _inputDevices
            .where((device) => device.id == preferredId)
            .firstOrNull
            ?.name ??
        '已断开的麦克风';
  }

  List<double> get inputAmplitudeWindow =>
      List<double>.unmodifiable(_inputAmplitudeWindow);

  bool get canStart =>
      _phase == RecordingPhase.idle || _phase == RecordingPhase.error;
  bool get canPause => _phase == RecordingPhase.recording;
  bool get canResume => _phase == RecordingPhase.paused;
  bool get canStop =>
      _phase == RecordingPhase.recording || _phase == RecordingPhase.paused;

  String get actionLabel {
    switch (_phase) {
      case RecordingPhase.starting:
        return '正在启动录音...';
      case RecordingPhase.recording:
        return '暂停录音';
      case RecordingPhase.paused:
        return '继续录音';
      case RecordingPhase.stopping:
        return '正在停止录音...';
      case RecordingPhase.error:
        return '重新开始';
      case RecordingPhase.idle:
        return '开始录音';
    }
  }

  Future<void> reloadSettings() async {
    try {
      final settings = await _appSettingsRepository.load();
      _activeModelId = settings.modelId;
      _autoTranscribeEnabled = settings.autoTranscribe;
    } catch (_) {
      _activeModelId = 'paraformer-zh';
      _autoTranscribeEnabled = true;
    }
    notifyListeners();
  }

  Future<void> initialize() async {
    await reloadSettings();
    await reattach();
    await refreshInputDevices();
    await refreshRecoveries();
  }

  Future<bool> refreshInputDevices() async {
    try {
      _inputDevices = await _recorder.listInputDevices();
      _inputSelectionSupported = _inputDevices.any(
        (device) => device.canSelect,
      );
      notifyListeners();
      return true;
    } on RecorderException catch (error) {
      _inputRouteNotice = error.message;
      notifyListeners();
      return false;
    }
  }

  Future<bool> selectInputDevice(int? deviceId) async {
    try {
      final snapshot = await _recorder.selectInputDevice(deviceId);
      _preferredInputDeviceId = snapshot.preferredInputDeviceId;
      _inputSelectionSupported =
          snapshot.inputSelectionSupported || _inputSelectionSupported;
      _inputRouteNotice = null;
      if (snapshot.isActive) {
        _applyTelemetry(snapshot);
      }
      notifyListeners();
      return true;
    } on RecorderException catch (error) {
      _inputRouteNotice = error.message;
      notifyListeners();
      return false;
    }
  }

  Future<bool> hasCurrentRecordingConsent({int requiredVersion = 1}) {
    return _appSettingsRepository.hasCurrentRecordingConsent(requiredVersion);
  }

  Future<void> acceptRecordingConsent({int version = 1}) {
    return _appSettingsRepository.acceptRecordingConsent(version);
  }

  Future<void> start() async {
    if (!canStart) return;
    _setPhase(RecordingPhase.starting);

    final bool granted = await _permissionService.ensurePermissionGranted();
    if (!granted) {
      _permissionDenied = true;
      _setError('麦克风权限未开启，请在系统设置中允许麦克风访问');
      return;
    }

    try {
      await reloadSettings();
      final snapshot = await _recorder.start();
      await _recordingSessionsRepository.upsertSnapshot(snapshot);
      _permissionDenied = false;
      _errorMessage = null;
      _inputRouteNotice = null;
      _activeSessionId = snapshot.sessionId;
      _elapsedMs = snapshot.durationMs;
      _startTicker();
      _applyTelemetry(snapshot);
      _setPhase(RecordingPhase.recording);
      _startTelemetrySampling();
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<void> pause() async {
    if (!canPause) return;
    try {
      final snapshot = await _recorder.pause();
      await _recordingSessionsRepository.upsertSnapshot(snapshot);
      _elapsedMs = snapshot.durationMs;
      _stopTicker();
      _stopTelemetrySampling();
      _applyTelemetry(snapshot);
      _setPhase(RecordingPhase.paused);
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<void> resume() async {
    if (!canResume) return;
    try {
      final snapshot = await _recorder.resume();
      await _recordingSessionsRepository.upsertSnapshot(snapshot);
      _elapsedMs = snapshot.durationMs;
      _startTicker();
      _applyTelemetry(snapshot);
      _setPhase(RecordingPhase.recording);
      _startTelemetrySampling();
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<bool> stop() async {
    if (!canStop) return false;
    _setPhase(RecordingPhase.stopping);
    _stopTicker();
    _stopTelemetrySampling(reset: true);

    try {
      final RecorderResult result = await _recorder.stop();
      _elapsedMs = result.durationMs;
      await reloadSettings();
      await _recordingSessionsRepository.commitCompleted(
        result,
        enqueueTranscription: _autoTranscribeEnabled,
      );
      if (_autoTranscribeEnabled) {
        _transcriptionQueueCoordinator?.kick();
      }
      _activeSessionId = null;

      await refreshRecoveries();
      _setPhase(RecordingPhase.idle);
      return true;
    } on RecorderException catch (e) {
      _setError(e.message);
      return false;
    } catch (e) {
      _setError('录音保存或加入转写队列失败: $e');
      return false;
    }
  }

  Future<void> togglePrimaryAction() async {
    if (_phase == RecordingPhase.recording) {
      await pause();
      return;
    }
    if (_phase == RecordingPhase.paused) {
      await resume();
      return;
    }
    await start();
  }

  Future<InterruptionResult> handleLifecycleInterruption() async {
    if (_phase != RecordingPhase.recording && _phase != RecordingPhase.paused) {
      return InterruptionResult.ignored;
    }
    return InterruptionResult.continuesInBackground;
  }

  Future<void> reattach() async {
    try {
      final snapshot = await _recoveryCoordinator.reattach(
        enqueueTranscription: _autoTranscribeEnabled,
      );
      if (snapshot.isCompleted && _autoTranscribeEnabled) {
        _transcriptionQueueCoordinator?.kick();
      }
      _activeSessionId = snapshot.isActive ? snapshot.sessionId : null;
      _elapsedMs = snapshot.durationMs;
      switch (snapshot.state) {
        case 'recording':
          _errorMessage = null;
          _startTicker();
          _applyTelemetry(snapshot);
          _setPhase(RecordingPhase.recording);
          _startTelemetrySampling();
          break;
        case 'paused':
          _errorMessage = null;
          _stopTicker();
          _stopTelemetrySampling();
          _applyTelemetry(snapshot);
          _setPhase(RecordingPhase.paused);
          break;
        case 'completed':
        case 'idle':
          _stopTicker();
          _stopTelemetrySampling(reset: true);
          _elapsedMs = 0;
          _setPhase(RecordingPhase.idle);
          break;
        case 'recoverable':
        case 'invalid':
        case 'failed':
          _stopTicker();
          _stopTelemetrySampling(reset: true);
          _setError('发现未完成录音，请先恢复或清理');
          break;
        default:
          _stopTicker();
          _stopTelemetrySampling(reset: true);
          _setPhase(RecordingPhase.idle);
          break;
      }
    } on RecorderException catch (error) {
      _setError(error.message);
    }
  }

  Future<void> refreshRecoveries() async {
    try {
      _recoveryCandidates = await _recoveryCoordinator.refresh();
    } on RecorderException catch (error) {
      _errorMessage = error.message;
    }
    notifyListeners();
  }

  Future<bool> recoverRecording(String sessionId) async {
    try {
      await _recoveryCoordinator.recover(
        sessionId,
        enqueueTranscription: _autoTranscribeEnabled,
      );
      if (_autoTranscribeEnabled) {
        _transcriptionQueueCoordinator?.kick();
      }
      await refreshRecoveries();
      _errorMessage = null;
      if (_phase == RecordingPhase.error) {
        _setPhase(RecordingPhase.idle);
      }
      return true;
    } on RecorderException catch (error) {
      _setError(error.message);
      return false;
    }
  }

  Future<bool> discardRecovery(String sessionId) async {
    try {
      await _recoveryCoordinator.discard(sessionId);
      await refreshRecoveries();
      if (_recoveryCandidates.isEmpty && _phase == RecordingPhase.error) {
        _errorMessage = null;
        _setPhase(RecordingPhase.idle);
      }
      return true;
    } on RecorderException catch (error) {
      _setError(error.message);
      return false;
    }
  }

  @override
  void dispose() {
    _stopTicker();
    _stopTelemetrySampling();
    super.dispose();
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      _elapsedMs += 1000;
      notifyListeners();
    });
  }

  void _stopTicker() {
    _ticker?.cancel();
    _ticker = null;
  }

  void _startTelemetrySampling() {
    _telemetryTicker?.cancel();
    unawaited(_pollTelemetry());
    _telemetryTicker = Timer.periodic(
      const Duration(milliseconds: 180),
      (_) => unawaited(_pollTelemetry()),
    );
  }

  void _stopTelemetrySampling({bool reset = false}) {
    _telemetryTicker?.cancel();
    _telemetryTicker = null;
    if (reset) {
      _inputStatus = RecordingInputStatus.unknown;
      _inputDeviceType = RecordingInputDeviceType.unknown;
      _inputDeviceId = null;
      _inputDeviceName = null;
      _inputAmplitudeWindow = List<double>.filled(inputAmplitudeWindowSize, 0);
    }
  }

  Future<void> _pollTelemetry() async {
    if (_telemetryPollInFlight || _phase != RecordingPhase.recording) return;
    _telemetryPollInFlight = true;
    try {
      final snapshot = await _recorder.getState();
      if (_phase != RecordingPhase.recording) return;
      if (snapshot.isCompleted) {
        if (snapshot.stopReason == 'input_device_lost') {
          _inputRouteNotice = '所选麦克风已断开且无法安全切换，录音已停止并保存';
        }
        await reattach();
        return;
      }
      _applyTelemetry(snapshot);
      notifyListeners();
    } catch (_) {
      if (_phase != RecordingPhase.recording) return;
      _inputStatus = RecordingInputStatus.unknown;
      _inputDeviceType = RecordingInputDeviceType.unknown;
      _appendAmplitude(0);
      notifyListeners();
    } finally {
      _telemetryPollInFlight = false;
    }
  }

  void _applyTelemetry(RecordingSessionSnapshot snapshot) {
    _inputStatus = snapshot.inputStatus;
    _inputDeviceType = snapshot.inputDeviceType;
    _inputDeviceId = snapshot.inputDeviceId;
    _inputDeviceName = snapshot.inputDeviceName;
    _preferredInputDeviceId = snapshot.preferredInputDeviceId;
    _inputSelectionSupported =
        snapshot.inputSelectionSupported || _inputSelectionSupported;
    if (snapshot.inputFallbackReason ==
        RecordingInputFallbackReason.deviceDisconnected) {
      _inputRouteNotice = '所选麦克风已断开，已切换到系统默认输入';
    }
    final double normalized = math.sqrt(
      snapshot.inputAmplitude / RecordingSessionSnapshot.maxInputAmplitude,
    );
    _appendAmplitude(normalized.clamp(0, 1).toDouble());
  }

  void _appendAmplitude(double amplitude) {
    _inputAmplitudeWindow = <double>[
      ..._inputAmplitudeWindow.skip(1),
      amplitude,
    ];
  }

  void _setError(String message) {
    _stopTicker();
    _stopTelemetrySampling(reset: true);
    _errorMessage = message;
    _setPhase(RecordingPhase.error);
  }

  void _setPhase(RecordingPhase next) {
    _phase = next;
    notifyListeners();
  }
}

enum InterruptionResult { ignored, continuesInBackground }

const int inputAmplitudeWindowSize = 36;
