import '../model/transcription_result.dart';

class TranscriptionRequest {
  TranscriptionRequest({
    required this.recordingPath,
    required this.durationMs,
    required this.modelId,
    this.sampleRateHz = 16000,
    this.enablePunctuation = true,
    this.enableDenoise = false,
    this.attemptCount = 1,
  });

  final String recordingPath;
  final int durationMs;
  final String modelId;
  final int sampleRateHz;
  final bool enablePunctuation;
  final bool enableDenoise;
  final int attemptCount;
}

class TranscriptionProgressEvent {
  const TranscriptionProgressEvent({
    required this.jobId,
    required this.stage,
    required this.progress,
  });

  factory TranscriptionProgressEvent.fromMap(Map<Object?, Object?> map) {
    return TranscriptionProgressEvent(
      jobId: (map['jobId'] as num?)?.toInt() ?? 0,
      stage: map['stage'] as String? ?? 'unknown',
      progress: ((map['progress'] as num?)?.toDouble() ?? 0).clamp(0, 1),
    );
  }

  final int jobId;
  final String stage;
  final double progress;
}

class TranscriptionFailure implements Exception {
  const TranscriptionFailure({
    required this.code,
    required this.stage,
    required this.message,
  });

  final String code;
  final String stage;
  final String message;

  @override
  String toString() => message;
}

class TranscriptionCanceledException extends TranscriptionFailure {
  const TranscriptionCanceledException()
    : super(code: 'CANCELED', stage: 'cancellation', message: '任务已取消');
}

abstract class TranscriptionPort {
  Stream<TranscriptionProgressEvent> get progressEvents;

  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  });

  Future<void> cancel(int jobId);

  Future<Set<int>> activeJobIds();
}
