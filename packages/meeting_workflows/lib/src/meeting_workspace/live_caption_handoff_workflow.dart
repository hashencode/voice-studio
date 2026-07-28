enum MeetingHandoffStage { captureCommit, draftFlush, formalEnqueue }

class CommittedMeetingCapture {
  const CommittedMeetingCapture({
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

class MeetingHandoffOutcome {
  const MeetingHandoffOutcome({
    required this.capture,
    required this.draftFlushed,
    required this.formalJob,
  });

  final CommittedMeetingCapture capture;
  final bool draftFlushed;
  final FormalTranscriptionJobReference formalJob;
}

class MeetingHandoffFailure implements Exception {
  const MeetingHandoffFailure({
    required this.stage,
    required this.cause,
    this.committedCapture,
  });

  final MeetingHandoffStage stage;
  final Object cause;
  final CommittedMeetingCapture? committedCapture;
}

abstract interface class MeetingCaptureCommitPort {
  /// Must stop new audio, native-finalize tracks, then commit recording/hash.
  Future<CommittedMeetingCapture> stopAndCommit({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  });
}

abstract interface class MeetingDraftHandoffPort {
  Future<void> attachCommittedCapture(CommittedMeetingCapture capture);

  /// Returns false when captions degraded; authority capture remains usable.
  Future<bool> flushAndClose();
}

abstract interface class MeetingFormalTranscriptionPort {
  Future<FormalTranscriptionJobReference> enqueuePostMeeting(
    CommittedMeetingCapture capture,
  );
}

/// Encodes the authority order. Draft failure is non-fatal and never prevents
/// formal processing from being enqueued after the recording commit.
class LiveCaptionHandoffWorkflow {
  const LiveCaptionHandoffWorkflow({
    required MeetingCaptureCommitPort capture,
    required MeetingFormalTranscriptionPort formal,
    MeetingDraftHandoffPort? draft,
  }) : _capture = capture,
       _draft = draft,
       _formal = formal;

  final MeetingCaptureCommitPort _capture;
  final MeetingDraftHandoffPort? _draft;
  final MeetingFormalTranscriptionPort _formal;

  Future<MeetingHandoffOutcome> stop({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    late final CommittedMeetingCapture committed;
    try {
      committed = await _capture.stopAndCommit(
        sessionId: sessionId,
        idempotencyKey: idempotencyKey,
        displayName: displayName,
      );
    } catch (error) {
      throw MeetingHandoffFailure(
        stage: MeetingHandoffStage.captureCommit,
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
      final job = await _formal.enqueuePostMeeting(committed);
      return MeetingHandoffOutcome(
        capture: committed,
        draftFlushed: draftFlushed,
        formalJob: job,
      );
    } catch (error) {
      throw MeetingHandoffFailure(
        stage: MeetingHandoffStage.formalEnqueue,
        cause: error,
        committedCapture: committed,
      );
    }
  }
}
