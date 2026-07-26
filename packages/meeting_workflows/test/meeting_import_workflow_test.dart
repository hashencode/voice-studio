import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  test(
    'duplicate hash returns the existing recording without a second job',
    () async {
      final commitPort = _MemoryCommitPort();
      final activeWorkflow = MeetingImportWorkflow(commitPort: commitPort);
      const candidate = MeetingMediaCandidate(
        path: '/private/meeting.m4a',
        displayName: 'meeting.m4a',
        sizeBytes: 4096,
        durationMs: 12000,
        fingerprintSha256: 'same-hash',
        duplicateAsset: false,
      );

      final first = await activeWorkflow.commit(candidate);
      final second = await activeWorkflow.commit(candidate);

      expect(first.inserted, isTrue);
      expect(first.processingJob?.state, ProcessingJobState.queued);
      expect(second.inserted, isFalse);
      expect(second.recordingId, first.recordingId);
      expect(second.processingJob, isNull);
      expect(commitPort.recordingCount, 1);
      expect(commitPort.jobCount, 1);
    },
  );
}

class _MemoryCommitPort implements MeetingImportCommitPort {
  final Map<String, int> _recordingIds = <String, int>{};
  int jobCount = 0;

  int get recordingCount => _recordingIds.length;

  @override
  Future<MeetingImportCommitResult> commit(
    MeetingMediaCandidate candidate,
  ) async {
    final existingId = _recordingIds[candidate.fingerprintSha256];
    if (existingId != null) {
      return MeetingImportCommitResult(
        recordingId: existingId,
        inserted: false,
        existingPath: '/private/meeting.m4a',
      );
    }
    final id = _recordingIds.length + 1;
    _recordingIds[candidate.fingerprintSha256] = id;
    jobCount += 1;
    return MeetingImportCommitResult(
      recordingId: id,
      inserted: true,
      processingJob: ProcessingJobReference(
        id: jobCount,
        state: ProcessingJobState.queued,
        inputSha256: candidate.fingerprintSha256,
      ),
    );
  }
}
