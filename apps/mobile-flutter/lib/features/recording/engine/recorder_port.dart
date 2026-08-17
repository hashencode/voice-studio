abstract class RecorderPort {
  Future<RecordingSessionSnapshot> start({String? sessionId});
  Future<RecordingSessionSnapshot> pause();
  Future<RecordingSessionSnapshot> resume();
  Future<RecorderResult> stop({String reason = 'user_stop'});
  Future<RecordingSessionSnapshot> getState();
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      const <RecordingInputDevice>[];
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) =>
      getState();
  Future<List<RecordingRecoveryCandidate>> listRecoveries();
  Future<RecorderResult> recover(String sessionId);
  Future<void> discardRecovery(String sessionId);
}

class RecordingSessionSnapshot {
  const RecordingSessionSnapshot({
    required this.sessionId,
    required this.state,
    required this.durationMs,
    this.stagingPath,
    this.canonicalPath,
    this.stopReason,
    this.errorCategory,
    this.createdAtMs,
    this.updatedAtMs,
    this.inputAmplitude = 0,
    this.inputStatus = RecordingInputStatus.unknown,
    this.inputDeviceType = RecordingInputDeviceType.unknown,
    this.inputAvailable = false,
    this.inputDeviceId,
    this.inputDeviceName,
    this.preferredInputDeviceId,
    this.inputFallbackReason = RecordingInputFallbackReason.none,
    this.inputSelectionSupported = false,
  });

  factory RecordingSessionSnapshot.idle() {
    return const RecordingSessionSnapshot(
      sessionId: '',
      state: 'idle',
      durationMs: 0,
    );
  }

  factory RecordingSessionSnapshot.fromMap(Map<Object?, Object?> raw) {
    return RecordingSessionSnapshot(
      sessionId: raw['sessionId'] as String? ?? '',
      state: raw['state'] as String? ?? 'idle',
      durationMs: (raw['durationMs'] as num?)?.toInt() ?? 0,
      stagingPath: raw['stagingPath'] as String?,
      canonicalPath: raw['canonicalPath'] as String? ?? raw['path'] as String?,
      stopReason: raw['stopReason'] as String?,
      errorCategory: raw['errorCategory'] as String?,
      createdAtMs: (raw['createdAtMs'] as num?)?.toInt(),
      updatedAtMs: (raw['updatedAtMs'] as num?)?.toInt(),
      inputAmplitude: ((raw['inputAmplitude'] as num?)?.toInt() ?? 0)
          .clamp(0, maxInputAmplitude)
          .toInt(),
      inputStatus: RecordingInputStatus.fromWireValue(
        raw['inputStatus'] as String?,
      ),
      inputDeviceType: RecordingInputDeviceType.fromWireValue(
        raw['inputDeviceType'] as String?,
      ),
      inputAvailable: raw['inputAvailable'] as bool? ?? false,
      inputDeviceId: (raw['inputDeviceId'] as num?)?.toInt(),
      inputDeviceName: raw['inputDeviceName'] as String?,
      preferredInputDeviceId: (raw['preferredInputDeviceId'] as num?)?.toInt(),
      inputFallbackReason: RecordingInputFallbackReason.fromWireValue(
        raw['inputFallbackReason'] as String?,
      ),
      inputSelectionSupported: raw['inputSelectionSupported'] as bool? ?? false,
    );
  }

  final String sessionId;
  final String state;
  final int durationMs;
  final String? stagingPath;
  final String? canonicalPath;
  final String? stopReason;
  final String? errorCategory;
  final int? createdAtMs;
  final int? updatedAtMs;
  final int inputAmplitude;
  final RecordingInputStatus inputStatus;
  final RecordingInputDeviceType inputDeviceType;
  final bool inputAvailable;
  final int? inputDeviceId;
  final String? inputDeviceName;
  final int? preferredInputDeviceId;
  final RecordingInputFallbackReason inputFallbackReason;
  final bool inputSelectionSupported;

  bool get isActive => state == 'recording' || state == 'paused';
  bool get isCompleted => state == 'completed';

  static const int maxInputAmplitude = 32767;
}

enum RecordingInputStatus {
  available,
  silent,
  paused,
  unknown;

  static RecordingInputStatus fromWireValue(String? value) {
    return switch (value) {
      'available' => RecordingInputStatus.available,
      'silent' => RecordingInputStatus.silent,
      'paused' => RecordingInputStatus.paused,
      _ => RecordingInputStatus.unknown,
    };
  }
}

enum RecordingInputDeviceType {
  builtIn,
  wired,
  bluetooth,
  usb,
  external,
  unknown;

  static RecordingInputDeviceType fromWireValue(String? value) {
    return switch (value) {
      'built_in' => RecordingInputDeviceType.builtIn,
      'wired' => RecordingInputDeviceType.wired,
      'bluetooth' => RecordingInputDeviceType.bluetooth,
      'usb' => RecordingInputDeviceType.usb,
      'external' => RecordingInputDeviceType.external,
      _ => RecordingInputDeviceType.unknown,
    };
  }
}

enum RecordingInputFallbackReason {
  none,
  deviceDisconnected;

  static RecordingInputFallbackReason fromWireValue(String? value) {
    return switch (value) {
      'device_disconnected' => RecordingInputFallbackReason.deviceDisconnected,
      _ => RecordingInputFallbackReason.none,
    };
  }
}

class RecordingInputDevice {
  const RecordingInputDevice({
    required this.id,
    required this.name,
    required this.type,
    required this.canSelect,
  });

  factory RecordingInputDevice.fromMap(Map<Object?, Object?> raw) {
    return RecordingInputDevice(
      id: (raw['id'] as num?)?.toInt() ?? 0,
      name: raw['name'] as String? ?? '未命名麦克风',
      type: RecordingInputDeviceType.fromWireValue(
        raw['inputDeviceType'] as String?,
      ),
      canSelect: raw['canSelect'] as bool? ?? false,
    );
  }

  final int id;
  final String name;
  final RecordingInputDeviceType type;
  final bool canSelect;
}

class RecordingRecoveryCandidate extends RecordingSessionSnapshot {
  const RecordingRecoveryCandidate({
    required super.sessionId,
    required super.state,
    required super.durationMs,
    super.stagingPath,
    super.canonicalPath,
    super.stopReason,
    super.errorCategory,
    super.createdAtMs,
    super.updatedAtMs,
  });

  factory RecordingRecoveryCandidate.fromMap(Map<Object?, Object?> raw) {
    final snapshot = RecordingSessionSnapshot.fromMap(raw);
    return RecordingRecoveryCandidate(
      sessionId: snapshot.sessionId,
      state: snapshot.state,
      durationMs: snapshot.durationMs,
      stagingPath: snapshot.stagingPath,
      canonicalPath: snapshot.canonicalPath,
      stopReason: snapshot.stopReason,
      errorCategory: snapshot.errorCategory,
      createdAtMs: snapshot.createdAtMs,
      updatedAtMs: snapshot.updatedAtMs,
    );
  }

  bool get canRecover => state == 'recoverable';
}

class RecorderResult {
  const RecorderResult({
    required this.sessionId,
    required this.path,
    required this.durationMs,
    this.stopReason,
  });

  factory RecorderResult.fromMap(Map<Object?, Object?> raw) {
    return RecorderResult(
      sessionId: raw['sessionId'] as String? ?? '',
      path: raw['path'] as String? ?? raw['canonicalPath'] as String? ?? '',
      durationMs: (raw['durationMs'] as num?)?.toInt() ?? 0,
      stopReason: raw['stopReason'] as String?,
    );
  }

  final String sessionId;
  final String path;
  final int durationMs;
  final String? stopReason;
}

class RecorderException implements Exception {
  RecorderException(this.message, {this.code = 'RECORDING_FAILED'});

  final String code;
  final String message;

  @override
  String toString() => 'RecorderException($code): $message';
}
