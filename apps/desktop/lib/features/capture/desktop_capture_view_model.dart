import 'package:flutter/foundation.dart';

import '../captions/live_caption_models.dart';
import 'desktop_capture_models.dart';
import 'desktop_capture_recovery.dart';

enum DesktopCapturePhase {
  idle,
  checking,
  ready,
  starting,
  recording,
  paused,
  stopping,
  completed,
  failed,
}

@immutable
class DesktopCaptureViewModel {
  const DesktopCaptureViewModel({
    this.phase = DesktopCapturePhase.idle,
    this.preflight,
    this.snapshot,
    this.elapsed = Duration.zero,
    this.captionAvailable = false,
    this.captionEnabled = false,
    this.selectedMicrophoneId,
    this.draftUtterances = const <LiveCaptionUtterance>[],
    this.captionBacklogBytes = 0,
    this.captionError,
    this.error,
    this.recoveries = const <DesktopCaptureRecoveryResult>[],
  });

  final DesktopCapturePhase phase;
  final DesktopCapturePreflight? preflight;
  final DesktopCaptureSessionSnapshot? snapshot;
  final Duration elapsed;
  final bool captionAvailable;
  final bool captionEnabled;
  final String? selectedMicrophoneId;
  final List<LiveCaptionUtterance> draftUtterances;
  final int captionBacklogBytes;
  final String? captionError;
  final String? error;
  final List<DesktopCaptureRecoveryResult> recoveries;

  bool get isActive =>
      phase == DesktopCapturePhase.starting ||
      phase == DesktopCapturePhase.recording ||
      phase == DesktopCapturePhase.paused ||
      phase == DesktopCapturePhase.stopping;

  bool get canStart =>
      phase == DesktopCapturePhase.ready && preflight?.canStart == true;

  bool get partialCapture => snapshot?.partialCapture == true;
  bool get systemAudioHealthy => snapshot?.systemAudioHealthy == true;
  bool get microphoneHealthy => snapshot?.microphoneHealthy == true;
  bool get microphoneOnly =>
      (snapshot?.captureMode ?? preflight?.captureMode) ==
      DesktopCaptureMode.microphoneOnly;

  String get draftText => draftUtterances
      .map((utterance) => utterance.text.trim())
      .where((text) => text.isNotEmpty)
      .join(' ');

  DesktopCaptureViewModel copyWith({
    DesktopCapturePhase? phase,
    DesktopCapturePreflight? preflight,
    DesktopCaptureSessionSnapshot? snapshot,
    Duration? elapsed,
    bool? captionAvailable,
    bool? captionEnabled,
    String? selectedMicrophoneId,
    bool clearSelectedMicrophone = false,
    List<LiveCaptionUtterance>? draftUtterances,
    int? captionBacklogBytes,
    String? captionError,
    bool clearCaptionError = false,
    String? error,
    bool clearError = false,
    List<DesktopCaptureRecoveryResult>? recoveries,
  }) {
    return DesktopCaptureViewModel(
      phase: phase ?? this.phase,
      preflight: preflight ?? this.preflight,
      snapshot: snapshot ?? this.snapshot,
      elapsed: elapsed ?? this.elapsed,
      captionAvailable: captionAvailable ?? this.captionAvailable,
      captionEnabled: captionEnabled ?? this.captionEnabled,
      selectedMicrophoneId: clearSelectedMicrophone
          ? null
          : selectedMicrophoneId ?? this.selectedMicrophoneId,
      draftUtterances: draftUtterances ?? this.draftUtterances,
      captionBacklogBytes: captionBacklogBytes ?? this.captionBacklogBytes,
      captionError: clearCaptionError
          ? null
          : captionError ?? this.captionError,
      error: clearError ? null : error ?? this.error,
      recoveries: recoveries ?? this.recoveries,
    );
  }
}
