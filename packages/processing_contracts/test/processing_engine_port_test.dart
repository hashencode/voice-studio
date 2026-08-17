import 'dart:async';

import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  test('desktop envelope rejects oversized and under-provisioned imports', () {
    const envelope = ProcessingOperationalEnvelope.desktopV1;
    expect(
      envelope.rejectImport(
        sourceBytes: envelope.maxSourceBytes + 1,
        availableBytes: 1 << 50,
      ),
      'SOURCE_TOO_LARGE',
    );
    expect(
      envelope.rejectImport(sourceBytes: 1024, availableBytes: 1024),
      'INSUFFICIENT_FREE_SPACE',
    );
  });

  test('cancellation token is cooperative and deterministic', () {
    final token = ProcessingCancellationToken()..cancel();
    expect(token.throwIfCancelled, throwsA(isA<ProcessingCancelled>()));
  });

  test('deadline cancellation is visible without an event-loop timer', () {
    final token = ProcessingCancellationToken()..setDeadline(Duration.zero);
    expect(token.isCancelled, isTrue);
    expect(token.throwIfCancelled, throwsA(isA<ProcessingTimedOut>()));
  });

  test('non-AI export keeps anonymous speaker labels and timestamps', () {
    final output = NonAiAudioExport.toWebVtt(const [
      ProcessingTranscriptSegment(
        startSeconds: 1.25,
        endSeconds: 2.5,
        text: '本地转写',
        speakerAssignment: SpeakerAssignment.anonymous,
        anonymousSpeakerKey: 'speaker_01',
      ),
    ]);
    expect(output, contains('00:00:01.250 --> 00:00:02.500'));
    expect(output, contains('[speaker_01] 本地转写'));
  });

  test(
    'timeout cancels native work and always releases temporary lease',
    () async {
      final token = ProcessingCancellationToken();
      final lease = _FakeLease();
      final engine = _NeverCompletingEngine();
      await expectLater(
        const ProcessingJobSupervisor().run(
          engine: engine,
          request: const ProcessingRequest(
            sourcePath: 'private/audio.wav',
            sourceSha256:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            durationSeconds: 10,
          ),
          cancellationToken: token,
          temporaryLease: lease,
          timeout: const Duration(milliseconds: 1),
          onProgress: (_) {},
        ),
        throwsA(isA<ProcessingTimedOut>()),
      );
      expect(token.isCancelled, isTrue);
      expect(lease.released, isTrue);
    },
  );

  test('review correction preserves timing and anonymous speaker identity', () {
    final review = ReviewableAudioTranscript(const [
      ProcessingTranscriptSegment(
        startSeconds: 2,
        endSeconds: 3,
        text: '原文',
        speakerAssignment: SpeakerAssignment.anonymous,
        anonymousSpeakerKey: 'speaker_01',
      ),
    ]);
    review.correctText(0, '人工修订');
    expect(review.revisionCount, 1);
    expect(review.segments.single.text, '人工修订');
    expect(review.segments.single.startSeconds, 2);
    expect(review.segments.single.anonymousSpeakerKey, 'speaker_01');
  });
}

class _FakeLease implements ProcessingTemporaryLease {
  bool released = false;

  @override
  Future<void> release() async {
    released = true;
  }
}

class _NeverCompletingEngine implements ProcessingEnginePort {
  @override
  String get engineId => 'test-never-completes';

  @override
  Future<ProcessingResult> process(
    ProcessingRequest request, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) {
    return Completer<ProcessingResult>().future;
  }
}
