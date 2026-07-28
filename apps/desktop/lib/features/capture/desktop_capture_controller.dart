import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:meeting_workflows/meeting_workflows.dart';

import '../captions/desktop_live_caption_service.dart';
import '../captions/live_caption_models.dart';
import 'desktop_capture_models.dart';
import 'desktop_capture_port.dart';
import 'desktop_capture_service.dart';
import 'desktop_capture_view_model.dart';

abstract interface class DesktopCaptureUiController {
  DesktopCaptureViewModel get value;
  Future<void> preflight({bool requestPermissions = false});
  void selectMicrophone(String deviceId);
  void setCaptionEnabled(bool enabled);
  Future<void> start();
  Future<void> pause();
  Future<void> resume();
  Future<void> restartCaptions();
  Future<MeetingHandoffOutcome?> stop({String displayName = '电脑会议'});
  Future<void> keepRecovered(String sessionId);
  Future<void> discardRecovered(String sessionId);
  void reset();
}

class DesktopCaptureController extends ChangeNotifier
    implements DesktopCaptureUiController {
  DesktopCaptureController({
    required DesktopCaptureService captureService,
    required MeetingFormalTranscriptionPort formalTranscription,
    DesktopLiveCaptionService? liveCaptions,
    String? captionModelSha256,
    DateTime Function()? clock,
    this.minimumFreeBytes = 1024 * 1024 * 1024,
  }) : _captureService = captureService,
       _formalTranscription = formalTranscription,
       _liveCaptions = liveCaptions,
       _captionModelSha256 = captionModelSha256,
       _clock = clock ?? DateTime.now {
    _snapshotSubscription = _captureService.snapshots.listen(_applySnapshot);
    _menuSubscription = _captureService.menuActions.listen(_handleMenuAction);
    _utteranceSubscription = _liveCaptions?.utterances.listen(_appendUtterance);
    _captionFailureSubscription = _liveCaptions?.failures.listen(
      _handleCaptionFailure,
    );
  }

  final DesktopCaptureService _captureService;
  final MeetingFormalTranscriptionPort _formalTranscription;
  final DesktopLiveCaptionService? _liveCaptions;
  final String? _captionModelSha256;
  final DateTime Function() _clock;
  final int minimumFreeBytes;
  StreamSubscription<DesktopCaptureSessionSnapshot>? _snapshotSubscription;
  StreamSubscription<DesktopCaptureMenuAction>? _menuSubscription;
  StreamSubscription<LiveCaptionUtterance>? _utteranceSubscription;
  StreamSubscription<String>? _captionFailureSubscription;
  Timer? _clockTimer;
  final Stopwatch _elapsed = Stopwatch();
  Future<MeetingHandoffOutcome>? _stopOperation;
  String? _sessionId;
  bool _disposed = false;

  DesktopCaptureViewModel _value = const DesktopCaptureViewModel();
  @override
  DesktopCaptureViewModel get value => _value;

  Future<void> Function(MeetingHandoffOutcome outcome)? onCompleted;

  Future<void> initialize() async {
    final recoveries = await _captureService.recoverInterrupted();
    _set(
      _value.copyWith(
        recoveries: recoveries
            .where(
              (result) =>
                  result.state == 'recoverable' ||
                  result.state == 'partial_capture',
            )
            .toList(growable: false),
        captionAvailable: _liveCaptions != null && _captionModelSha256 != null,
      ),
    );
  }

  @override
  Future<void> preflight({bool requestPermissions = false}) async {
    _set(
      _value.copyWith(phase: DesktopCapturePhase.checking, clearError: true),
    );
    try {
      final result = await _captureService.preflight(
        minimumFreeBytes: minimumFreeBytes,
        captionModelAvailable: _value.captionAvailable,
        requestPermissions: requestPermissions,
      );
      final selected =
          result.microphones.any(
            (device) => device.id == _value.selectedMicrophoneId,
          )
          ? _value.selectedMicrophoneId
          : result.microphones
                .where((device) => device.isDefault)
                .map((device) => device.id)
                .firstOrNull;
      _set(
        _value.copyWith(
          phase: DesktopCapturePhase.ready,
          preflight: result,
          selectedMicrophoneId: selected,
          captionEnabled: _value.captionAvailable,
          clearError: true,
        ),
      );
    } catch (error) {
      _set(
        _value.copyWith(
          phase: DesktopCapturePhase.failed,
          error: '录音前检查失败：${error.runtimeType}',
        ),
      );
    }
  }

  @override
  void selectMicrophone(String deviceId) {
    final devices = _value.preflight?.microphones ?? const [];
    if (!devices.any((device) => device.id == deviceId)) return;
    _set(_value.copyWith(selectedMicrophoneId: deviceId));
  }

  @override
  void setCaptionEnabled(bool enabled) {
    _set(
      _value.copyWith(
        captionEnabled: enabled && _value.captionAvailable,
        clearCaptionError: enabled,
      ),
    );
  }

  @override
  Future<void> start() async {
    if (!_value.canStart || _value.isActive) return;
    final sessionId = _newSessionId();
    _sessionId = sessionId;
    _set(
      _value.copyWith(
        phase: DesktopCapturePhase.starting,
        draftUtterances: const <LiveCaptionUtterance>[],
        captionBacklogBytes: 0,
        clearCaptionError: true,
        clearError: true,
      ),
    );
    try {
      final snapshot = await _captureService.start(
        sessionId: sessionId,
        idempotencyKey: 'start-$sessionId',
        minimumFreeBytes: minimumFreeBytes,
        microphoneDeviceId: _value.selectedMicrophoneId,
        captionEnabled: _value.captionEnabled,
      );
      _applySnapshot(snapshot);
      if (_value.captionEnabled) {
        final durable = await _captureService.sessionRecord(sessionId);
        try {
          await _liveCaptions!.start(
            sessionId: sessionId,
            sessionRoot: durable!.workspacePath,
            modelSha256: _captionModelSha256!,
          );
        } catch (_) {
          _set(
            _value.copyWith(
              captionEnabled: false,
              captionError: '实时草稿暂不可用；录音继续，会后仍会生成正式转写',
            ),
          );
        }
      }
      _elapsed
        ..reset()
        ..start();
      _startClock();
      _set(_value.copyWith(phase: DesktopCapturePhase.recording));
    } catch (error) {
      _sessionId = null;
      _set(
        _value.copyWith(
          phase: DesktopCapturePhase.failed,
          error: '无法开始录音：${error.runtimeType}',
        ),
      );
    }
  }

  @override
  Future<void> pause() async {
    final sessionId = _sessionId;
    if (sessionId == null || _value.phase != DesktopCapturePhase.recording) {
      return;
    }
    try {
      final snapshot = await _captureService.pause(
        sessionId: sessionId,
        idempotencyKey: 'pause-$sessionId-${_clock().millisecondsSinceEpoch}',
      );
      _elapsed.stop();
      await _liveCaptions?.pause();
      _applySnapshot(snapshot);
      _set(_value.copyWith(phase: DesktopCapturePhase.paused));
    } catch (error) {
      _set(_value.copyWith(error: '暂停失败：${error.runtimeType}'));
    }
  }

  @override
  Future<void> resume() async {
    final sessionId = _sessionId;
    if (sessionId == null || _value.phase != DesktopCapturePhase.paused) {
      return;
    }
    try {
      final snapshot = await _captureService.resume(
        sessionId: sessionId,
        idempotencyKey: 'resume-$sessionId-${_clock().millisecondsSinceEpoch}',
      );
      _elapsed.start();
      await _liveCaptions?.resume();
      _applySnapshot(snapshot);
      _set(_value.copyWith(phase: DesktopCapturePhase.recording));
    } catch (error) {
      _set(_value.copyWith(error: '继续录音失败：${error.runtimeType}'));
    }
  }

  @override
  Future<void> restartCaptions() async {
    if (!_value.isActive || _liveCaptions == null) return;
    try {
      await _liveCaptions.restart();
      _set(
        _value.copyWith(
          captionEnabled: true,
          captionBacklogBytes: _liveCaptions.backlogBytes,
          clearCaptionError: true,
        ),
      );
    } catch (_) {
      _set(
        _value.copyWith(
          captionEnabled: false,
          captionError: '实时草稿重启失败；当前录音不受影响',
        ),
      );
    }
  }

  @override
  Future<MeetingHandoffOutcome?> stop({String displayName = '电脑会议'}) async {
    final existing = _stopOperation;
    if (existing != null) return existing;
    final sessionId = _sessionId;
    if (sessionId == null ||
        !{
          DesktopCapturePhase.recording,
          DesktopCapturePhase.paused,
        }.contains(_value.phase)) {
      return null;
    }
    _elapsed.stop();
    _clockTimer?.cancel();
    _set(_value.copyWith(phase: DesktopCapturePhase.stopping));
    final operation =
        LiveCaptionHandoffWorkflow(
          capture: _captureService,
          draft: _value.captionEnabled ? _liveCaptions : null,
          formal: _formalTranscription,
        ).stop(
          sessionId: sessionId,
          idempotencyKey: 'stop-$sessionId',
          displayName: displayName,
        );
    _stopOperation = operation;
    try {
      final outcome = await operation;
      _sessionId = null;
      _set(
        _value.copyWith(
          phase: DesktopCapturePhase.completed,
          captionError: outcome.draftFlushed
              ? _value.captionError
              : '草稿 flush 失败；录音已保留，正式转写仍已排队',
        ),
      );
      await onCompleted?.call(outcome);
      return outcome;
    } on MeetingHandoffFailure catch (failure) {
      _set(
        _value.copyWith(
          phase: DesktopCapturePhase.failed,
          error: failure.committedCapture == null
              ? '停止录音未完成；可从恢复页继续处理'
              : '录音已安全保存，但正式转写排队失败；可重试',
        ),
      );
      return null;
    } finally {
      _stopOperation = null;
    }
  }

  @override
  Future<void> keepRecovered(String sessionId) async {
    try {
      final capture = await _captureService.keepRecovered(
        sessionId: sessionId,
        displayName: '恢复的电脑会议',
      );
      final job = await _formalTranscription.enqueuePostMeeting(capture);
      final outcome = MeetingHandoffOutcome(
        capture: capture,
        draftFlushed: false,
        formalJob: job,
      );
      _set(
        _value.copyWith(
          recoveries: _value.recoveries
              .where((result) => result.sessionId != sessionId)
              .toList(growable: false),
        ),
      );
      await onCompleted?.call(outcome);
    } catch (error) {
      _set(_value.copyWith(error: '恢复会议失败：${error.runtimeType}'));
    }
  }

  @override
  Future<void> discardRecovered(String sessionId) async {
    try {
      await _captureService.discardRecovered(sessionId);
      _set(
        _value.copyWith(
          recoveries: _value.recoveries
              .where((result) => result.sessionId != sessionId)
              .toList(growable: false),
        ),
      );
    } catch (error) {
      _set(_value.copyWith(error: '删除恢复会话失败：${error.runtimeType}'));
    }
  }

  @override
  void reset() {
    if (_value.isActive) return;
    _elapsed.reset();
    _set(
      DesktopCaptureViewModel(
        captionAvailable: _value.captionAvailable,
        recoveries: _value.recoveries,
      ),
    );
  }

  void _applySnapshot(DesktopCaptureSessionSnapshot snapshot) {
    if (_sessionId != null && snapshot.sessionId != _sessionId) return;
    final systemPaused =
        snapshot.state == DesktopCaptureSessionState.paused &&
        {
          'system_sleep',
          'system_wake_requires_resume',
        }.contains(snapshot.interruptionReason);
    if (systemPaused) {
      _elapsed.stop();
      final previousReason = _value.snapshot?.interruptionReason;
      if (previousReason != 'system_sleep' &&
          previousReason != 'system_wake_requires_resume') {
        unawaited(_pauseCaptionsForSystemSleep());
      }
    }
    _set(
      _value.copyWith(
        snapshot: snapshot,
        phase: switch (snapshot.state) {
          DesktopCaptureSessionState.recording => DesktopCapturePhase.recording,
          DesktopCaptureSessionState.paused => DesktopCapturePhase.paused,
          DesktopCaptureSessionState.finalizing => DesktopCapturePhase.stopping,
          DesktopCaptureSessionState.completed => DesktopCapturePhase.completed,
          DesktopCaptureSessionState.failed => DesktopCapturePhase.failed,
          _ => _value.phase,
        },
      ),
    );
  }

  Future<void> _pauseCaptionsForSystemSleep() async {
    try {
      await _liveCaptions?.pause();
    } catch (_) {
      _handleCaptionFailure('CAPTION_SLEEP_PAUSE_FAILED');
    }
  }

  void _appendUtterance(LiveCaptionUtterance utterance) {
    if (utterance.sessionId != _sessionId) return;
    _set(
      _value.copyWith(
        draftUtterances: <LiveCaptionUtterance>[
          ..._value.draftUtterances,
          utterance,
        ],
        captionBacklogBytes: _liveCaptions?.backlogBytes ?? 0,
      ),
    );
  }

  void _handleMenuAction(DesktopCaptureMenuAction action) {
    switch (action) {
      case DesktopCaptureMenuAction.pause:
        unawaited(pause());
      case DesktopCaptureMenuAction.resume:
        unawaited(resume());
      case DesktopCaptureMenuAction.stop:
        unawaited(stop());
    }
  }

  void _handleCaptionFailure(String code) {
    _set(
      _value.copyWith(
        captionEnabled: false,
        captionError: '实时草稿已降级（$code）；录音继续，会后仍会正式转写',
      ),
    );
  }

  void _startClock() {
    _clockTimer?.cancel();
    _clockTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      _set(
        _value.copyWith(
          elapsed: _elapsed.elapsed,
          captionBacklogBytes: _liveCaptions?.backlogBytes ?? 0,
        ),
      );
    });
  }

  void _set(DesktopCaptureViewModel next) {
    _value = next;
    if (!_disposed) notifyListeners();
  }

  String _newSessionId() {
    final random = Random.secure();
    final suffix = List<int>.generate(
      8,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
    return 'session-${_clock().millisecondsSinceEpoch}-$suffix';
  }

  @override
  void dispose() {
    _disposed = true;
    _clockTimer?.cancel();
    unawaited(_snapshotSubscription?.cancel());
    unawaited(_menuSubscription?.cancel());
    unawaited(_utteranceSubscription?.cancel());
    unawaited(_captionFailureSubscription?.cancel());
    unawaited(_liveCaptions?.dispose());
    super.dispose();
  }
}
