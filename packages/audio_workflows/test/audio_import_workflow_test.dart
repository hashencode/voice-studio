import 'package:audio_core/audio_core.dart';
import 'package:audio_workflows/audio_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  test(
    'duplicate hash returns the existing recording without a second job',
    () async {
      final commitPort = _MemoryCommitPort();
      final activeWorkflow = AudioImportWorkflow(commitPort: commitPort);
      const candidate = AudioMediaCandidate(
        path: '/private/audio.m4a',
        displayName: 'audio.m4a',
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

class _MemoryCommitPort implements AudioImportCommitPort {
  final Map<String, int> _recordingIds = <String, int>{};
  int jobCount = 0;

  int get recordingCount => _recordingIds.length;

  @override
  Future<AudioImportCommitResult> commit(AudioMediaCandidate candidate) async {
    final existingId = _recordingIds[candidate.fingerprintSha256];
    if (existingId != null) {
      return AudioImportCommitResult(
        recordingId: existingId,
        inserted: false,
        existingPath: '/private/audio.m4a',
      );
    }
    final id = _recordingIds.length + 1;
    _recordingIds[candidate.fingerprintSha256] = id;
    jobCount += 1;
    return AudioImportCommitResult(
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
