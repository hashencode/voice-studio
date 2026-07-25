import '../model/transcription_result.dart';
import 'transcription_port.dart';

class FakeTranscriptionService implements TranscriptionPort {
  @override
  Stream<TranscriptionProgressEvent> get progressEvents =>
      const Stream<TranscriptionProgressEvent>.empty();

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 400));
    return TranscriptionResult.singleText(
      '[mock] model=${request.modelId} '
      '${request.recordingPath.split('/').last} 转写完成, '
      '时长 ${request.durationMs}ms',
      durationMs: request.durationMs,
    );
  }

  @override
  Future<void> cancel(int jobId) async {}

  @override
  Future<Set<int>> activeJobIds() async => const <int>{};
}
