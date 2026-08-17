enum AudioHandoffStage { captureCommit, draftFlush, formalEnqueue }

class CommittedAudioCapture {
  const CommittedAudioCapture({
    required this.sessionId,
    required this.recordingId,
    required this.recordingPath,
    required this.processingPath,
    required this.recordingSha256,
    required this.durationMs,
    required this.partialCapture,
  });

  final String sessionId;
  final int recordingId;
  final String recordingPath;
  final String processingPath;
  final String recordingSha256;
  final int durationMs;
  final bool partialCapture;
}

class FormalTranscriptionJobReference {
  const FormalTranscriptionJobReference({
    required this.jobId,
    required this.inserted,
  });

  final int jobId;
  final bool inserted;
}

class AudioHandoffOutcome {
  const AudioHandoffOutcome({
    required this.capture,
    required this.draftFlushed,
    required this.formalJob,
  });

  final CommittedAudioCapture capture;
  final bool draftFlushed;
  final FormalTranscriptionJobReference formalJob;
}

class AudioHandoffFailure implements Exception {
  const AudioHandoffFailure({
    required this.stage,
    required this.cause,
    this.committedCapture,
  });

  final AudioHandoffStage stage;
  final Object cause;
  final CommittedAudioCapture? committedCapture;
}

abstract interface class AudioCaptureCommitPort {
  /// Must stop new audio, native-finalize tracks, then commit recording/hash.
  Future<CommittedAudioCapture> stopAndCommit({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  });
}

abstract interface class AudioDraftHandoffPort {
  Future<void> attachCommittedCapture(CommittedAudioCapture capture);

  /// Returns false when captions degraded; authority capture remains usable.
  Future<bool> flushAndClose();
}

abstract interface class AudioFormalTranscriptionPort {
  Future<FormalTranscriptionJobReference> enqueuePostAudio(
    CommittedAudioCapture capture,
  );
}

/// Encodes the authority order. Draft failure is non-fatal and never prevents
/// formal processing from being enqueued after the recording commit.
class LiveCaptionHandoffWorkflow {
  const LiveCaptionHandoffWorkflow({
    required AudioCaptureCommitPort capture,
    required AudioFormalTranscriptionPort formal,
    AudioDraftHandoffPort? draft,
  }) : _capture = capture,
       _draft = draft,
       _formal = formal;

  final AudioCaptureCommitPort _capture;
  final AudioDraftHandoffPort? _draft;
  final AudioFormalTranscriptionPort _formal;

  Future<AudioHandoffOutcome> stop({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    late final CommittedAudioCapture committed;
    try {
      committed = await _capture.stopAndCommit(
        sessionId: sessionId,
        idempotencyKey: idempotencyKey,
        displayName: displayName,
      );
    } catch (error) {
      throw AudioHandoffFailure(
        stage: AudioHandoffStage.captureCommit,
        cause: error,
      );
    }

    var draftFlushed = true;
    final draft = _draft;
    if (draft != null) {
      try {
        await draft.attachCommittedCapture(committed);
        draftFlushed = await draft.flushAndClose();
      } catch (_) {
        draftFlushed = false;
      }
    }

    try {
      final job = await _formal.enqueuePostAudio(committed);
      return AudioHandoffOutcome(
        capture: committed,
        draftFlushed: draftFlushed,
        formalJob: job,
      );
    } catch (error) {
      throw AudioHandoffFailure(
        stage: AudioHandoffStage.formalEnqueue,
        cause: error,
        committedCapture: committed,
      );
    }
  }
}
