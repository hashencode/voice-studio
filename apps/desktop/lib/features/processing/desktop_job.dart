enum DesktopJobState {
  pending,
  processing,
  completed,
  failed,
  canceled;

  static DesktopJobState fromWireValue(String value) => switch (value) {
    'pending' => pending,
    'processing' => processing,
    'completed' => completed,
    'failed' => failed,
    'canceled' => canceled,
    _ => failed,
  };
}

class DesktopProcessingJob {
  const DesktopProcessingJob({
    required this.id,
    required this.recordingId,
    required this.displayName,
    required this.recordingPath,
    required this.fingerprintSha256,
    required this.state,
    required this.stage,
    required this.progress,
    required this.createdAtMs,
    this.errorCode,
  });

  final int id;
  final int recordingId;
  final String displayName;
  final String recordingPath;
  final String fingerprintSha256;
  final DesktopJobState state;
  final String stage;
  final double progress;
  final int createdAtMs;
  final String? errorCode;
}
