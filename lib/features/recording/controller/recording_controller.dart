import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../records/repository/recordings_repository.dart';
import '../../settings/repository/app_settings_repository.dart';
import '../../transcription/repository/transcription_jobs_repository.dart';
import '../../transcription/service/transcription_port.dart';
import '../engine/recorder_port.dart';
import '../model/recording_phase.dart';
import '../services/microphone_permission_service.dart';

class RecordingController extends ChangeNotifier {
  RecordingController({
    required MicrophonePermissionService permissionService,
    required RecorderPort recorder,
    required RecordingsRepository recordingsRepository,
    required TranscriptionJobsRepository transcriptionJobsRepository,
    required TranscriptionPort transcriptionService,
    required AppSettingsRepository appSettingsRepository,
  }) : _permissionService = permissionService,
       _recorder = recorder,
       _recordingsRepository = recordingsRepository,
       _transcriptionJobsRepository = transcriptionJobsRepository,
       _transcriptionService = transcriptionService,
       _appSettingsRepository = appSettingsRepository;

  final MicrophonePermissionService _permissionService;
  final RecorderPort _recorder;
  final RecordingsRepository _recordingsRepository;
  final TranscriptionJobsRepository _transcriptionJobsRepository;
  final TranscriptionPort _transcriptionService;
  final AppSettingsRepository _appSettingsRepository;

  RecordingPhase _phase = RecordingPhase.idle;
  String? _errorMessage;
  int _elapsedMs = 0;
  String? _activeModelId;
  bool _autoTranscribeEnabled = true;
  bool _handlingInterruption = false;
  bool _permissionDenied = false;
  Timer? _ticker;

  RecordingPhase get phase => _phase;
  String? get errorMessage => _errorMessage;
  int get elapsedMs => _elapsedMs;
  String? get activeModelId => _activeModelId;
  bool get autoTranscribeEnabled => _autoTranscribeEnabled;
  bool get permissionDenied => _permissionDenied;

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
      await _recorder.start();
      _permissionDenied = false;
      _errorMessage = null;
      _elapsedMs = 0;
      _startTicker();
      _setPhase(RecordingPhase.recording);
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<void> pause() async {
    if (!canPause) return;
    try {
      await _recorder.pause();
      _stopTicker();
      _setPhase(RecordingPhase.paused);
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<void> resume() async {
    if (!canResume) return;
    try {
      await _recorder.resume();
      _startTicker();
      _setPhase(RecordingPhase.recording);
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<bool> stop() async {
    if (!canStop) return false;
    _setPhase(RecordingPhase.stopping);
    _stopTicker();

    try {
      final RecorderResult result = await _recorder.stop();
      _elapsedMs = result.durationMs;
      await _recordingsRepository.insert(
        filePath: result.path,
        durationMs: result.durationMs,
      );

      await reloadSettings();
      if (_autoTranscribeEnabled) {
        await _runOfflineTranscriptionJob(
          result,
          recordingMode: 'standard',
          source: 'standard_offline',
        );
      }

      _setPhase(RecordingPhase.idle);
      return true;
    } on RecorderException catch (e) {
      _setError(e.message);
      return false;
    } catch (e) {
      _setError('录音保存或转写收尾失败: $e');
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
    if (_handlingInterruption) return InterruptionResult.ignored;
    if (_phase != RecordingPhase.recording && _phase != RecordingPhase.paused) {
      return InterruptionResult.ignored;
    }

    _handlingInterruption = true;
    try {
      final bool saved = await stop();
      return saved ? InterruptionResult.autoSaved : InterruptionResult.failed;
    } finally {
      _handlingInterruption = false;
    }
  }

  @override
  void dispose() {
    _stopTicker();
    super.dispose();
  }

  Future<void> _runOfflineTranscriptionJob(
    RecorderResult result, {
    required String recordingMode,
    required String source,
  }) async {
    final int jobId = await _transcriptionJobsRepository.insertPendingJob(
      recordingPath: result.path,
      durationMs: result.durationMs,
      recordingMode: recordingMode,
      source: source,
    );

    try {
      await _transcriptionJobsRepository.updateStatus(
        id: jobId,
        status: 'processing',
        recordingMode: recordingMode,
        source: source,
      );
      final text = await _transcriptionService.transcribe(
        TranscriptionRequest(
          recordingPath: result.path,
          durationMs: result.durationMs,
          modelId: _activeModelId ?? 'paraformer-zh',
          sampleRateHz: 16000,
          enablePunctuation: false,
          enableDenoise: false,
        ),
      );
      await _transcriptionJobsRepository.updateStatus(
        id: jobId,
        status: 'completed',
        resultText: text,
        recordingMode: recordingMode,
        source: source,
      );
      debugPrint('transcribe ok jobId=$jobId durationMs=${result.durationMs}');
    } catch (e) {
      await _transcriptionJobsRepository.updateStatus(
        id: jobId,
        status: 'failed',
        errorMessage: e.toString(),
        recordingMode: recordingMode,
        source: source,
        failureStage: source,
      );
      debugPrint('transcribe failed jobId=$jobId error=$e');
    }
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

  void _setError(String message) {
    _stopTicker();
    _errorMessage = message;
    _setPhase(RecordingPhase.error);
  }

  void _setPhase(RecordingPhase next) {
    _phase = next;
    notifyListeners();
  }
}

enum InterruptionResult { ignored, autoSaved, failed }
