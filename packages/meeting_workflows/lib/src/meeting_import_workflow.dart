import 'package:meeting_core/meeting_core.dart';
import 'package:processing_contracts/processing_contracts.dart';

abstract interface class MeetingImportCommitPort {
  Future<MeetingImportCommitResult> commit(MeetingMediaCandidate candidate);
}

class MeetingImportCommitResult {
  const MeetingImportCommitResult({
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

class MeetingImportWorkflow {
  const MeetingImportWorkflow({required MeetingImportCommitPort commitPort})
    : _commitPort = commitPort;

  final MeetingImportCommitPort _commitPort;

  Future<MeetingImportCommitResult> commit(MeetingMediaCandidate candidate) {
    if (!candidate.isValid) {
      throw const FormatException('meeting media candidate is incomplete');
    }
    return _commitPort.commit(candidate);
  }
}
