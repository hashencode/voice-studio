import 'dart:convert';

import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  const hash =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  test('handshake fails closed on version or capability mismatch', () {
    final handshake = SidecarHandshake.fromEnvelope(
      SidecarEnvelope.decode(
        jsonEncode(<String, Object?>{
          'protocolVersion': 1,
          'type': 'handshake',
          'messageId': 'hello-1',
          'jobId': null,
          'attemptId': null,
          'payload': <String, Object?>{
            'runtimeId': 'funasr',
            'runtimeVersion': '1.3.22',
            'capabilities': <String>['asr.zh'],
          },
        }),
      ),
    );

    expect(
      () => handshake.requireExpected(
        expectedRuntimeId: 'funasr',
        expectedRuntimeVersion: '1.3.21',
        requiredCapabilities: const <String>{'asr.zh'},
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_VERSION_MISMATCH',
        ),
      ),
    );
    expect(
      () => handshake.requireExpected(
        expectedRuntimeId: 'funasr',
        expectedRuntimeVersion: '1.3.22',
        requiredCapabilities: const <String>{'asr.zh', 'timestamp'},
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_CAPABILITY_MISMATCH',
        ),
      ),
    );
  });

  test('job paths are root-relative and traversal is rejected', () {
    expect(
      () => SidecarJobRequest(
        jobId: 'job-1',
        attemptId: 'attempt-1',
        sourceRelativePath: '../secret.wav',
        sourceSha256: hash,
        sourceBytes: 1,
        durationSeconds: 1,
        capability: 'asr.zh',
        maxSegments: 1,
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_PATH_ESCAPE',
        ),
      ),
    );
  });

  test('oversize JSONL is rejected before decoding', () {
    expect(
      () => SidecarEnvelope.decode('x' * (sidecarMaximumJsonLineBytes + 1)),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_OUTPUT_LIMIT',
        ),
      ),
    );
  });

  test('stale result and out-of-bounds output cannot be accepted', () {
    SidecarEnvelope result({required String attemptId, double end = 2}) =>
        SidecarEnvelope(
          type: SidecarMessageType.result,
          messageId: 'result-1',
          jobId: 'job-1',
          attemptId: attemptId,
          payload: <String, Object?>{
            'engineId': 'funasr-1.3.22',
            'segments': <Object?>[
              <String, Object?>{
                'startSeconds': 0,
                'endSeconds': end,
                'text': '本地结果',
                'speakerAssignment': 'unknown',
                'anonymousSpeakerKey': null,
              },
            ],
          },
        );

    expect(
      () => SidecarResult.fromEnvelope(
        result(attemptId: 'attempt-old'),
        expectedJobId: 'job-1',
        expectedAttemptId: 'attempt-current',
        durationSeconds: 2,
        maxSegments: 10,
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_STALE_RESULT',
        ),
      ),
    );
    expect(
      () => SidecarResult.fromEnvelope(
        result(attemptId: 'attempt-current', end: 2.1),
        expectedJobId: 'job-1',
        expectedAttemptId: 'attempt-current',
        durationSeconds: 2,
        maxSegments: 10,
      ),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_RESULT_INVALID',
        ),
      ),
    );
  });

  test('valid anonymous result preserves only anonymous identity', () {
    final result = SidecarResult.fromEnvelope(
      SidecarEnvelope(
        type: SidecarMessageType.result,
        messageId: 'result-1',
        jobId: 'job-1',
        attemptId: 'attempt-1',
        payload: <String, Object?>{
          'engineId': 'pyannote-4.0.4',
          'segments': <Object?>[
            <String, Object?>{
              'startSeconds': 0,
              'endSeconds': 1,
              'text': '片段',
              'speakerAssignment': 'anonymous',
              'anonymousSpeakerKey': 'speaker_01',
            },
          ],
        },
      ),
      expectedJobId: 'job-1',
      expectedAttemptId: 'attempt-1',
      durationSeconds: 1,
      maxSegments: 10,
    );

    expect(result.segments.single.anonymousSpeakerKey, 'speaker_01');
  });

  test('diarization result validates anonymous bounded turns', () {
    final result = SidecarSpeakerTurnResult.fromEnvelope(
      SidecarEnvelope(
        type: SidecarMessageType.result,
        messageId: 'result-1',
        jobId: 'job-1',
        attemptId: 'attempt-1',
        payload: <String, Object?>{
          'engineId': 'pyannote-4.0.4',
          'speakerTurns': <Object?>[
            <String, Object?>{
              'startSeconds': 0,
              'endSeconds': 1,
              'speakerAssignment': 'anonymous',
              'anonymousSpeakerKey': 'speaker_01',
            },
          ],
        },
      ),
      expectedJobId: 'job-1',
      expectedAttemptId: 'attempt-1',
      durationSeconds: 1,
      maxSegments: 10,
    );

    expect(result.turns.single.anonymousSpeakerKey, 'speaker_01');
  });
}
