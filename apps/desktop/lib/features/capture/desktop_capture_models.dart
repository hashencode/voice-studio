import 'package:flutter/foundation.dart';

enum DesktopCaptureSessionState {
  idle,
  preflight,
  preparing,
  recording,
  paused,
  finalizing,
  completed,
  recoverable,
  partialCapture,
  failed;

  static DesktopCaptureSessionState fromWire(String value) => switch (value) {
    'idle' => idle,
    'preflight' => preflight,
    'preparing' => preparing,
    'recording' => recording,
    'paused' => paused,
    'finalizing' => finalizing,
    'completed' => completed,
    'recoverable' => recoverable,
    'partial_capture' => partialCapture,
    'failed' => failed,
    _ => throw FormatException('Unknown capture state: $value'),
  };

  String get wireName => switch (this) {
    idle => 'idle',
    preflight => 'preflight',
    preparing => 'preparing',
    recording => 'recording',
    paused => 'paused',
    finalizing => 'finalizing',
    completed => 'completed',
    recoverable => 'recoverable',
    partialCapture => 'partial_capture',
    failed => 'failed',
  };
}

enum DesktopCapturePermissionState {
  notDetermined,
  granted,
  denied,
  restricted,
  revoked,
  unavailable;

  static DesktopCapturePermissionState fromWire(String value) =>
      switch (value) {
        'not_determined' => notDetermined,
        'granted' => granted,
        'denied' => denied,
        'restricted' => restricted,
        'revoked' => revoked,
        'unavailable' => unavailable,
        _ => throw FormatException('Unknown capture permission: $value'),
      };
}

enum DesktopCaptureTrackKind {
  systemAudio,
  microphone;

  static DesktopCaptureTrackKind fromWire(String value) => switch (value) {
    'system_audio' => systemAudio,
    'microphone' => microphone,
    _ => throw FormatException('Unknown capture track: $value'),
  };
}

enum DesktopCaptureMode {
  dualTrack,
  microphoneOnly;

  static DesktopCaptureMode fromWire(String value) => switch (value) {
    'dual_track' => dualTrack,
    'microphone_only' => microphoneOnly,
    _ => throw FormatException('Unknown capture mode: $value'),
  };

  String get wireName => switch (this) {
    dualTrack => 'dual_track',
    microphoneOnly => 'microphone_only',
  };
}

@immutable
class DesktopCaptureDevice {
  const DesktopCaptureDevice({
    required this.id,
    required this.name,
    required this.isDefault,
  });

  factory DesktopCaptureDevice.fromMap(Map<Object?, Object?> map) {
    return DesktopCaptureDevice(
      id: _requiredString(map, 'id'),
      name: _requiredString(map, 'name'),
      isDefault: map['isDefault'] == true,
    );
  }

  final String id;
  final String name;
  final bool isDefault;
}

@immutable
class DesktopCapturePreflight {
  const DesktopCapturePreflight({
    required this.minimumMacosVersion,
    this.systemAudioMinimumMacosVersion = '14.2',
    this.captureMode = DesktopCaptureMode.dualTrack,
    required this.systemAudioPermission,
    required this.microphonePermission,
    required this.microphones,
    required this.availableBytes,
    required this.requiredBytes,
    required this.captionModelAvailable,
    required this.canStart,
    required this.blockingReasons,
  });

  factory DesktopCapturePreflight.fromMap(Map<Object?, Object?> map) {
    final microphones = map['microphones'];
    final reasons = map['blockingReasons'];
    if (microphones is! List || reasons is! List) {
      throw const FormatException('Invalid capture preflight arrays');
    }
    return DesktopCapturePreflight(
      minimumMacosVersion: _requiredString(map, 'minimumMacosVersion'),
      systemAudioMinimumMacosVersion:
          map['systemAudioMinimumMacosVersion'] as String? ??
          _requiredString(map, 'minimumMacosVersion'),
      captureMode: DesktopCaptureMode.fromWire(
        map['captureMode'] as String? ?? 'dual_track',
      ),
      systemAudioPermission: DesktopCapturePermissionState.fromWire(
        _requiredString(map, 'systemAudioPermission'),
      ),
      microphonePermission: DesktopCapturePermissionState.fromWire(
        _requiredString(map, 'microphonePermission'),
      ),
      microphones: microphones
          .map(
            (value) => DesktopCaptureDevice.fromMap(
              (value as Map).cast<Object?, Object?>(),
            ),
          )
          .toList(growable: false),
      availableBytes: _requiredInt(map, 'availableBytes'),
      requiredBytes: _requiredInt(map, 'requiredBytes'),
      captionModelAvailable: map['captionModelAvailable'] == true,
      canStart: map['canStart'] == true,
      blockingReasons: reasons
          .map((value) => value as String)
          .toList(growable: false),
    );
  }

  final String minimumMacosVersion;
  final String systemAudioMinimumMacosVersion;
  final DesktopCaptureMode captureMode;
  final DesktopCapturePermissionState systemAudioPermission;
  final DesktopCapturePermissionState microphonePermission;
  final List<DesktopCaptureDevice> microphones;
  final int availableBytes;
  final int requiredBytes;
  final bool captionModelAvailable;
  final bool canStart;
  final List<String> blockingReasons;
}

@immutable
class DesktopCaptureStartRequest {
  const DesktopCaptureStartRequest({
    required this.sessionId,
    required this.sessionRoot,
    required this.idempotencyKey,
    required this.minimumFreeBytes,
    this.microphoneDeviceId,
    this.captionEnabled = false,
  });

  final String sessionId;
  final String sessionRoot;
  final String idempotencyKey;
  final int minimumFreeBytes;
  final String? microphoneDeviceId;
  final bool captionEnabled;

  Map<String, Object?> toMap() => <String, Object?>{
    'sessionId': sessionId,
    'sessionRoot': sessionRoot,
    'idempotencyKey': idempotencyKey,
    'minimumFreeBytes': minimumFreeBytes,
    'microphoneDeviceId': microphoneDeviceId,
    'captionEnabled': captionEnabled,
  };
}

@immutable
class DesktopCaptureSessionSnapshot {
  const DesktopCaptureSessionSnapshot({
    required this.sessionId,
    required this.state,
    this.captureMode = DesktopCaptureMode.dualTrack,
    required this.captureTimelineMs,
    required this.systemAudioHealthy,
    required this.microphoneHealthy,
    required this.partialCapture,
    required this.finalizedChunkCount,
    required this.eventCount,
    this.systemAudioLevel = 0,
    this.microphoneLevel = 0,
    this.interruptionReason,
    this.recordingId,
    this.recordingSha256,
  });

  factory DesktopCaptureSessionSnapshot.fromMap(Map<Object?, Object?> map) {
    return DesktopCaptureSessionSnapshot(
      sessionId: _requiredString(map, 'sessionId'),
      state: DesktopCaptureSessionState.fromWire(_requiredString(map, 'state')),
      captureMode: DesktopCaptureMode.fromWire(
        map['captureMode'] as String? ?? 'dual_track',
      ),
      captureTimelineMs: _requiredInt(map, 'captureTimelineMs'),
      systemAudioHealthy: map['systemAudioHealthy'] == true,
      microphoneHealthy: map['microphoneHealthy'] == true,
      partialCapture: map['partialCapture'] == true,
      finalizedChunkCount: _requiredInt(map, 'finalizedChunkCount'),
      eventCount: _requiredInt(map, 'eventCount'),
      systemAudioLevel: _normalizedLevel(map['systemAudioLevel']),
      microphoneLevel: _normalizedLevel(map['microphoneLevel']),
      interruptionReason: map['interruptionReason'] as String?,
      recordingId: map['recordingId'] as String?,
      recordingSha256: map['recordingSha256'] as String?,
    );
  }

  final String sessionId;
  final DesktopCaptureSessionState state;
  final DesktopCaptureMode captureMode;
  final int captureTimelineMs;
  final bool systemAudioHealthy;
  final bool microphoneHealthy;
  final bool partialCapture;
  final int finalizedChunkCount;
  final int eventCount;
  final double systemAudioLevel;
  final double microphoneLevel;
  final String? interruptionReason;
  final String? recordingId;
  final String? recordingSha256;

  Map<String, Object?> toMap() => <String, Object?>{
    'sessionId': sessionId,
    'state': state.wireName,
    'captureMode': captureMode.wireName,
    'captureTimelineMs': captureTimelineMs,
    'systemAudioHealthy': systemAudioHealthy,
    'microphoneHealthy': microphoneHealthy,
    'partialCapture': partialCapture,
    'finalizedChunkCount': finalizedChunkCount,
    'eventCount': eventCount,
    'systemAudioLevel': systemAudioLevel,
    'microphoneLevel': microphoneLevel,
    'interruptionReason': interruptionReason,
    'recordingId': recordingId,
    'recordingSha256': recordingSha256,
  };
}

double _normalizedLevel(Object? value) {
  if (value is! num || !value.isFinite) return 0;
  return value.toDouble().clamp(0, 1);
}

String _requiredString(Map<Object?, Object?> map, String key) {
  final value = map[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('Missing capture field: $key');
  }
  return value;
}

int _requiredInt(Map<Object?, Object?> map, String key) {
  final value = map[key];
  if (value is! num || !value.isFinite || value < 0) {
    throw FormatException('Invalid capture field: $key');
  }
  return value.toInt();
}
