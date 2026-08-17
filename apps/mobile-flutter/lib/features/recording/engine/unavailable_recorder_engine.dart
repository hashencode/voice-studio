import 'recorder_port.dart';

class UnavailableRecorderEngine implements RecorderPort {
  const UnavailableRecorderEngine({required this.platform});

  final String platform;

  RecorderException _failure() => RecorderException('$platform 尚未配置真实录音运行时');

  @override
  Future<RecordingSessionSnapshot> getState() async =>
      RecordingSessionSnapshot.idle();

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      const <RecordingInputDevice>[];

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) async =>
      throw _failure();

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) async =>
      throw _failure();

  @override
  Future<RecordingSessionSnapshot> pause() async => throw _failure();

  @override
  Future<RecordingSessionSnapshot> resume() async => throw _failure();

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) async =>
      throw _failure();

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async =>
      const <RecordingRecoveryCandidate>[];

  @override
  Future<RecorderResult> recover(String sessionId) async => throw _failure();

  @override
  Future<void> discardRecovery(String sessionId) async => throw _failure();
}
