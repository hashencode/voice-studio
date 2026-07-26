enum ProcessingJobState {
  queued,
  preparing,
  processing,
  completed,
  canceled,
  retryableFailure,
  terminalFailure,
}

class ProcessingJobReference {
  const ProcessingJobReference({
    required this.id,
    required this.state,
    required this.inputSha256,
  });

  final int id;
  final ProcessingJobState state;
  final String inputSha256;
}
