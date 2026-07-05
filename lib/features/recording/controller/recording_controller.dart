import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../records/repository/recordings_repository.dart';
import '../../settings/model/app_settings.dart';
import '../../settings/repository/app_settings_repository.dart';
import '../../transcription/repository/transcription_jobs_repository.dart';
import '../../transcription/repository/transcript_segments_repository.dart';
import '../../transcription/service/realtime_transcription_event.dart';
import '../../transcription/service/realtime_transcription_events_port.dart';
import '../../transcription/service/transcription_port.dart';
import '../engine/realtime_recorder_port.dart';
import '../engine/recorder_port.dart';
import '../model/live_transcript_state.dart';
import '../model/recording_phase.dart';
import '../services/microphone_permission_service.dart';

class RecordingController extends ChangeNotifier {
  RecordingController({
    required MicrophonePermissionService permissionService,
    required RecorderPort recorder,
    RealtimeRecorderPort? realtimeRecorder,
    required RecordingsRepository recordingsRepository,
    required TranscriptionJobsRepository transcriptionJobsRepository,
    TranscriptSegmentsRepository? transcriptSegmentsRepository,
    required TranscriptionPort transcriptionService,
    RealtimeTranscriptionEventsPort? realtimeEvents,
    required AppSettingsRepository appSettingsRepository,
  }) : _permissionService = permissionService,
       _recorder = recorder,
       _realtimeRecorder = realtimeRecorder ?? _UnsupportedRealtimeRecorder(),
       _recordingsRepository = recordingsRepository,
       _transcriptionJobsRepository = transcriptionJobsRepository,
       _transcriptSegmentsRepository =
           transcriptSegmentsRepository ?? TranscriptSegmentsRepository(),
       _transcriptionService = transcriptionService,
       _realtimeEvents = realtimeEvents,
       _appSettingsRepository = appSettingsRepository;

  final MicrophonePermissionService _permissionService;
  final RecorderPort _recorder;
  final RealtimeRecorderPort _realtimeRecorder;
  final RecordingsRepository _recordingsRepository;
  final TranscriptionJobsRepository _transcriptionJobsRepository;
  final TranscriptSegmentsRepository _transcriptSegmentsRepository;
  final TranscriptionPort _transcriptionService;
  final RealtimeTranscriptionEventsPort? _realtimeEvents;
  final AppSettingsRepository _appSettingsRepository;

  RecordingPhase _phase = RecordingPhase.idle;
  String? _errorMessage;
  int _elapsedMs = 0;
  String? _activeModelId;
  RecordingMode _configuredRecordingMode = RecordingMode.standard;
  RecordingMode _activeRecordingMode = RecordingMode.standard;
  LiveTranscriptState _liveTranscriptState = LiveTranscriptState.empty();
  String? _realtimeStatusMessage;
  bool _autoTranscribeEnabled = true;
  bool _handlingInterruption = false;
  bool _permissionDenied = false;
  Timer? _ticker;
  StreamSubscription<RealtimeTranscriptionEvent>? _realtimeSubscription;

  RecordingPhase get phase => _phase;
  String? get errorMessage => _errorMessage;
  int get elapsedMs => _elapsedMs;
  String? get activeModelId => _activeModelId;
  RecordingMode get configuredRecordingMode => _configuredRecordingMode;
  RecordingMode get activeRecordingMode => _activeRecordingMode;
  LiveTranscriptState get liveTranscriptState => _liveTranscriptState;
  String? get realtimeStatusMessage => _realtimeStatusMessage;
  bool get autoTranscribeEnabled => _autoTranscribeEnabled;
  bool get permissionDenied => _permissionDenied;
  bool get isRealtimeSession => _activeRecordingMode == RecordingMode.realtime;

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
      _configuredRecordingMode = settings.recordingMode;
      _autoTranscribeEnabled = settings.autoTranscribe;
    } catch (_) {
      _activeModelId = 'paraformer-zh';
      _configuredRecordingMode = RecordingMode.standard;
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
      _activeRecordingMode = _resolveRecordingMode(_configuredRecordingMode);
      _liveTranscriptState = LiveTranscriptState.empty();
      _realtimeStatusMessage = null;
      if (isRealtimeSession) {
        await _subscribeRealtimeEvents();
      }

      await _activeRecorder.start();
      _permissionDenied = false;
      _errorMessage = null;
      _elapsedMs = 0;
      _startTicker();
      _setPhase(RecordingPhase.recording);
    } on RecorderException catch (e) {
      await _cancelRealtimeEvents();
      _setError(e.message);
    }
  }

  Future<void> pause() async {
    if (!canPause) return;
    try {
      await _activeRecorder.pause();
      _stopTicker();
      _setPhase(RecordingPhase.paused);
    } on RecorderException catch (e) {
      _setError(e.message);
    }
  }

  Future<void> resume() async {
    if (!canResume) return;
    try {
      await _activeRecorder.resume();
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
      final RecordingMode stoppedMode = _activeRecordingMode;
      final RecorderResult result = await _activeRecorder.stop();
      await _cancelRealtimeEvents();
      _elapsedMs = result.durationMs;
      await _recordingsRepository.insert(
        filePath: result.path,
        durationMs: result.durationMs,
      );

      await reloadSettings();
      if (stoppedMode == RecordingMode.realtime) {
        await _finalizeRealtimeTranscription(result);
      } else if (_autoTranscribeEnabled) {
        await _runOfflineTranscriptionJob(
          result,
          recordingMode: RecordingMode.standard.storageValue,
          source: 'standard_offline',
        );
      }

      _activeRecordingMode = RecordingMode.standard;
      _setPhase(RecordingPhase.idle);
      return true;
    } on RecorderException catch (e) {
      await _cancelRealtimeEvents();
      _setError(e.message);
      return false;
    } catch (e) {
      await _cancelRealtimeEvents();
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
    _realtimeSubscription?.cancel();
    _realtimeEvents?.dispose();
    super.dispose();
  }

  RecorderPort get _activeRecorder {
    return isRealtimeSession ? _realtimeRecorder : _recorder;
  }

  RecordingMode _resolveRecordingMode(RecordingMode mode) {
    if (mode == RecordingMode.auto) {
      return RecordingMode.standard;
    }
    return mode;
  }

  Future<void> _subscribeRealtimeEvents() async {
    await _cancelRealtimeEvents();
    final RealtimeTranscriptionEventsPort? events = _realtimeEvents;
    if (events == null) {
      _realtimeStatusMessage = '实时事件通道不可用，录音将继续保存';
      return;
    }
    _realtimeSubscription = events.watch().listen(
      _handleRealtimeEvent,
      onError: (Object error) {
        _realtimeStatusMessage = '实时转写事件异常，录音将继续保存';
        notifyListeners();
      },
    );
  }

  Future<void> _cancelRealtimeEvents() async {
    await _realtimeSubscription?.cancel();
    _realtimeSubscription = null;
  }

  void _handleRealtimeEvent(RealtimeTranscriptionEvent event) {
    _liveTranscriptState = _liveTranscriptState.apply(event);
    if (event.isDegradation) {
      _realtimeStatusMessage = event.reason ?? '实时转写已降级，录音将继续保存';
    }
    if (event.isSegment) {
      unawaited(
        _transcriptSegmentsRepository.upsertSegment(
          recordingPath: event.recordingPath,
          jobId: event.jobId,
          sequenceId: event.sequenceId,
          text: event.text,
          startMs: event.startMs,
          endMs: event.endMs,
          isFinal: event.isFinal,
          source: event.source,
          confidence: event.confidence,
        ),
      );
    }
    notifyListeners();
  }

  Future<void> _finalizeRealtimeTranscription(RecorderResult result) async {
    String mergedText = _liveTranscriptState.mergedText.trim();
    if (mergedText.isEmpty) {
      mergedText =
          (await _transcriptSegmentsRepository.mergedTextForRecordingPath(
            result.path,
          )).trim();
    }

    if (mergedText.isNotEmpty) {
      final int jobId = await _transcriptionJobsRepository.insertPendingJob(
        recordingPath: result.path,
        durationMs: result.durationMs,
        recordingMode: RecordingMode.realtime.storageValue,
        source: 'realtime_final',
      );
      await _transcriptSegmentsRepository.attachJobId(
        recordingPath: result.path,
        jobId: jobId,
      );
      await _transcriptionJobsRepository.updateStatus(
        id: jobId,
        status: 'completed',
        resultText: mergedText,
        recordingMode: RecordingMode.realtime.storageValue,
        source: 'realtime_final',
      );
      debugPrint('realtime transcript completed jobId=$jobId');
      return;
    }

    if (_autoTranscribeEnabled) {
      await _runOfflineTranscriptionJob(
        result,
        recordingMode: RecordingMode.realtime.storageValue,
        source: 'realtime_fallback_offline',
      );
    }
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

class _UnsupportedRealtimeRecorder implements RealtimeRecorderPort {
  @override
  Future<void> start() {
    throw RecorderException('当前平台暂不支持实时转写录音');
  }

  @override
  Future<void> pause() {
    throw RecorderException('当前平台暂不支持实时转写录音');
  }

  @override
  Future<void> resume() {
    throw RecorderException('当前平台暂不支持实时转写录音');
  }

  @override
  Future<RecorderResult> stop() {
    throw RecorderException('当前平台暂不支持实时转写录音');
  }
}
