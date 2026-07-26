import '../model/transcription_result.dart';
import 'transcription_port.dart';

class UnavailableTranscriptionService implements TranscriptionPort {
  const UnavailableTranscriptionService({required this.platform});

  final String platform;

  TranscriptionFailure _failure() => TranscriptionFailure(
    code: 'PLATFORM_CAPABILITY_UNAVAILABLE',
    stage: 'capability',
    message: '$platform 尚未配置真实转写运行时',
  );

  @override
  Stream<TranscriptionProgressEvent> get progressEvents =>
      const Stream<TranscriptionProgressEvent>.empty();

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) async => throw _failure();

  @override
  Future<void> cancel(int jobId) async => throw _failure();

  @override
  Future<Set<int>> activeJobIds() async => const <int>{};
}
