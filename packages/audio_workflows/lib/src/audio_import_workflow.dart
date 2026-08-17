import 'package:audio_core/audio_core.dart';
import 'package:processing_contracts/processing_contracts.dart';

abstract interface class AudioImportCommitPort {
  Future<AudioImportCommitResult> commit(AudioMediaCandidate candidate);
}

class AudioImportCommitResult {
  const AudioImportCommitResult({
    required this.recordingId,
    required this.inserted,
    this.processingJob,
    this.existingPath,
  });

  final int recordingId;
  final bool inserted;
  final ProcessingJobReference? processingJob;
  final String? existingPath;
}

class AudioImportWorkflow {
  const AudioImportWorkflow({required AudioImportCommitPort commitPort})
    : _commitPort = commitPort;

  final AudioImportCommitPort _commitPort;

  Future<AudioImportCommitResult> commit(AudioMediaCandidate candidate) {
    if (!candidate.isValid) {
      throw const FormatException('audio media candidate is incomplete');
    }
    return _commitPort.commit(candidate);
  }
}
