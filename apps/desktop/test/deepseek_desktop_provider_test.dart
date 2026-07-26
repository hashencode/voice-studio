import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:voice2text_desktop/features/meeting_intelligence/deepseek_desktop_provider.dart';
import 'package:voice2text_desktop/features/secrets/desktop_secret_store.dart';

void main() {
  test('missing and unconsented requests perform zero network calls', () async {
    final missingTransport = _Transport(_successEnvelope());
    final missing = DeepSeekDesktopMeetingAiProvider(
      secretStore: _SecretStore(),
      transport: missingTransport,
    );
    final missingWorkflow = MeetingAiWorkflow(provider: missing);

    await expectLater(
      missingWorkflow.generate(_request(MeetingAiConsent.granted)),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.secretMissing,
        ),
      ),
    );
    expect(missingTransport.calls, 0);

    final deniedStore = _SecretStore(secret: 'sk-never-read');
    final deniedTransport = _Transport(_successEnvelope());
    final denied = DeepSeekDesktopMeetingAiProvider(
      secretStore: deniedStore,
      transport: deniedTransport,
    );
    await expectLater(
      MeetingAiWorkflow(
        provider: denied,
      ).generate(_request(MeetingAiConsent.denied)),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.consentRequired,
        ),
      ),
    );
    expect(deniedStore.reads, 0);
    expect(deniedTransport.calls, 0);
  });

  test(
    'sends anonymized transcript and parses evidence-linked output',
    () async {
      final transport = _Transport(_successEnvelope());
      final store = _SecretStore(secret: 'sk-test-secret');
      final provider = DeepSeekDesktopMeetingAiProvider(
        secretStore: store,
        transport: transport,
      );

      final output = await MeetingAiWorkflow(
        provider: provider,
      ).generate(_request(MeetingAiConsent.granted));

      expect(output.suggestedTitle, '发布会');
      expect(output.insights.single.evidence.single.segmentId, 41);
      expect(transport.headers?['authorization'], 'Bearer sk-test-secret');
      expect(transport.body, isNot(contains('敏感姓名')));
      expect(transport.body, isNot(contains('speaker_name')));
      expect(transport.body, isNot(contains('audio')));
      expect(transport.body, isNot(contains('sk-test-secret')));
      expect(store.reads, 2); // configured check, then request-time retrieval
    },
  );

  test(
    'maps authorization failures without exposing server body or secret',
    () async {
      final provider = DeepSeekDesktopMeetingAiProvider(
        secretStore: _SecretStore(secret: 'sk-sensitive'),
        transport: _Transport(
          const DesktopAiHttpResponse(401, 'server echoed sk-sensitive'),
        ),
      );

      await expectLater(
        MeetingAiWorkflow(
          provider: provider,
        ).generate(_request(MeetingAiConsent.granted)),
        throwsA(
          isA<MeetingAiFailure>()
              .having(
                (failure) => failure.code,
                'code',
                MeetingAiFailureCode.unauthorized,
              )
              .having(
                (failure) => failure.message,
                'message',
                isNot(contains('sk-sensitive')),
              ),
        ),
      );
    },
  );
}

MeetingAiRequest _request(MeetingAiConsent consent) => MeetingAiRequest(
  recordingId: 1,
  generationId: 2,
  consent: consent,
  segments: const <MeetingWorkspaceSegment>[
    MeetingWorkspaceSegment(
      id: 41,
      sequenceId: 0,
      text: '下周一发布。',
      startMs: 1000,
      endMs: 2500,
      reviewState: MeetingWorkspaceReviewState.reviewed,
      speakerState: MeetingWorkspaceSpeakerState.assigned,
      speakerId: 9,
      speakerName: '敏感姓名',
      speakerSource: 'manual',
    ),
  ],
  meetingTitle: '内部项目',
);

DesktopAiHttpResponse _successEnvelope() {
  final content = jsonEncode(<String, Object?>{
    'schema_version': 'meeting_intelligence_output/v1',
    'suggested_title': '发布会',
    'meeting_type': 'planning',
    'items': <Object?>[
      <String, Object?>{
        'kind': 'decision',
        'body': '下周一发布。',
        'evidence': <Object?>[
          <String, Object?>{'segment_id': 41, 'start_ms': 1000, 'end_ms': 2500},
        ],
      },
    ],
  });
  return DesktopAiHttpResponse(
    200,
    jsonEncode(<String, Object?>{
      'choices': <Object?>[
        <String, Object?>{
          'finish_reason': 'stop',
          'message': <String, Object?>{'content': content},
        },
      ],
    }),
  );
}

class _Transport implements DesktopAiHttpTransport {
  _Transport(this.response);

  final DesktopAiHttpResponse response;
  int calls = 0;
  Map<String, String>? headers;
  String? body;

  @override
  Future<DesktopAiHttpResponse> post({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    calls += 1;
    this.headers = headers;
    this.body = body;
    return response;
  }
}

class _SecretStore implements DesktopSecretStore {
  _SecretStore({this.secret});

  String? secret;
  int reads = 0;

  @override
  Future<bool> contains(String providerId) async {
    reads += 1;
    return secret?.isNotEmpty == true;
  }

  @override
  Future<void> delete(String providerId) async {
    secret = null;
  }

  @override
  Future<String?> read(String providerId) async {
    reads += 1;
    return secret;
  }

  @override
  Future<void> replace(String providerId, String secret) async {
    this.secret = secret.trim();
  }
}
