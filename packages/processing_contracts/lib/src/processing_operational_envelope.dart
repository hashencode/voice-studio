class ProcessingOperationalEnvelope {
  const ProcessingOperationalEnvelope({
    required this.maxSourceBytes,
    required this.maxDurationSeconds,
    required this.maxDecodedPcmBytes,
    required this.maxSegments,
    required this.maxQueuedJobs,
    required this.maxConcurrentEngines,
    required this.temporaryStorageMultiplier,
    required this.minimumFreeBytesAfterImport,
  });

  static const desktopV1 = ProcessingOperationalEnvelope(
    maxSourceBytes: 4 * 1024 * 1024 * 1024,
    maxDurationSeconds: 4 * 60 * 60,
    maxDecodedPcmBytes: 2 * 1024 * 1024 * 1024,
    maxSegments: 200000,
    maxQueuedJobs: 20,
    maxConcurrentEngines: 1,
    temporaryStorageMultiplier: 2.25,
    minimumFreeBytesAfterImport: 2 * 1024 * 1024 * 1024,
  );

  final int maxSourceBytes;
  final int maxDurationSeconds;
  final int maxDecodedPcmBytes;
  final int maxSegments;
  final int maxQueuedJobs;
  final int maxConcurrentEngines;
  final double temporaryStorageMultiplier;
  final int minimumFreeBytesAfterImport;

  int requiredFreeBytesForImport(int sourceBytes) {
    return (sourceBytes * temporaryStorageMultiplier).ceil() +
        minimumFreeBytesAfterImport;
  }

  String? rejectImport({
    required int sourceBytes,
    required int availableBytes,
    double? durationSeconds,
  }) {
    if (sourceBytes <= 0) return 'SOURCE_EMPTY';
    if (sourceBytes > maxSourceBytes) return 'SOURCE_TOO_LARGE';
    if (durationSeconds != null && durationSeconds > maxDurationSeconds) {
      return 'SOURCE_TOO_LONG';
    }
    if (availableBytes < requiredFreeBytesForImport(sourceBytes)) {
      return 'INSUFFICIENT_FREE_SPACE';
    }
    return null;
  }

  Map<String, Object> toJson() => {
    'maxSourceBytes': maxSourceBytes,
    'maxDurationSeconds': maxDurationSeconds,
    'maxDecodedPcmBytes': maxDecodedPcmBytes,
    'maxSegments': maxSegments,
    'maxQueuedJobs': maxQueuedJobs,
    'maxConcurrentEngines': maxConcurrentEngines,
    'temporaryStorageMultiplier': temporaryStorageMultiplier,
    'minimumFreeBytesAfterImport': minimumFreeBytesAfterImport,
  };
}
