import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:test/test.dart';

void main() {
  test('stop commits, flushes, then enqueues formal processing', () async {
    final order = <String>[];
    final workflow = LiveCaptionHandoffWorkflow(
      capture: _Capture(order),
      draft: _Draft(order),
      formal: _Formal(order),
    );

    final result = await workflow.stop(
      sessionId: 'session-u14',
      idempotencyKey: 'stop-u14',
      displayName: 'Meeting',
    );

    expect(order, <String>['capture', 'attach', 'flush', 'formal']);
    expect(result.draftFlushed, isTrue);
    expect(result.formalJob.jobId, 7);
  });

  test('caption failure does not prevent formal enqueue', () async {
    final order = <String>[];
    final workflow = LiveCaptionHandoffWorkflow(
      capture: _Capture(order),
      draft: _Draft(order, flushResult: false),
      formal: _Formal(order),
    );

    final result = await workflow.stop(
      sessionId: 'session-u14',
      idempotencyKey: 'stop-u14',
      displayName: 'Meeting',
    );

    expect(order, <String>['capture', 'attach', 'flush', 'formal']);
    expect(result.draftFlushed, isFalse);
  });

  test('formal failure reports committed capture for retry', () async {
    final order = <String>[];
    final workflow = LiveCaptionHandoffWorkflow(
      capture: _Capture(order),
      formal: _Formal(order, fail: true),
    );

    await expectLater(
      workflow.stop(
        sessionId: 'session-u14',
        idempotencyKey: 'stop-u14',
        displayName: 'Meeting',
      ),
      throwsA(
        isA<MeetingHandoffFailure>()
            .having(
              (failure) => failure.stage,
              'stage',
              MeetingHandoffStage.formalEnqueue,
            )
            .having(
              (failure) => failure.committedCapture?.recordingId,
              'recording',
              1,
            ),
      ),
    );
  });
}

CommittedMeetingCapture _capture() => const CommittedMeetingCapture(
  sessionId: 'session-u14',
  recordingId: 1,
  recordingPath: '/capture/journal.json',
  processingPath: '/capture/processing/qwen3-post-meeting.wav',
  recordingSha256:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  durationMs: 1000,
  partialCapture: false,
);

class _Capture implements MeetingCaptureCommitPort {
  _Capture(this.order);

  final List<String> order;

  @override
  Future<CommittedMeetingCapture> stopAndCommit({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    order.add('capture');
    return _capture();
  }
}

class _Draft implements MeetingDraftHandoffPort {
  _Draft(this.order, {this.flushResult = true});

  final List<String> order;
  final bool flushResult;

  @override
  Future<void> attachCommittedCapture(CommittedMeetingCapture capture) async {
    order.add('attach');
  }

  @override
  Future<bool> flushAndClose() async {
    order.add('flush');
    return flushResult;
  }
}

class _Formal implements MeetingFormalTranscriptionPort {
  _Formal(this.order, {this.fail = false});

  final List<String> order;
  final bool fail;

  @override
  Future<FormalTranscriptionJobReference> enqueuePostMeeting(
    CommittedMeetingCapture capture,
  ) async {
    order.add('formal');
    if (fail) throw StateError('injected');
    return const FormalTranscriptionJobReference(jobId: 7, inserted: true);
  }
}
