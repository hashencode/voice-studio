import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:voice2text_desktop/features/meeting_intelligence/openai_compatible_desktop_provider.dart';
import 'package:voice2text_desktop/features/secrets/desktop_secret_store.dart';

void main() {
  test('generic loopback transport generates without key or consent', () async {
    final transport = _Transport(_successEnvelope());
    final secrets = _SecretStore();
    final provider = OpenAiCompatibleDesktopMeetingAiProvider(
      providerId: 'loopback-contract-test',
      displayName: 'Loopback contract test',
      modelId: 'qwen3:8b',
      endpoint: DesktopAiEndpoint.parse('http://127.0.0.1:11434'),
      secretStore: secrets,
      requiresSecret: false,
      transport: transport,
    );

    final output = await MeetingAiWorkflow(
      provider: provider,
    ).generate(_request(MeetingAiConsent.denied));

    expect(output.insights.single.evidence.single.segmentId, 41);
    expect(transport.calls, 1);
    expect(transport.uri?.toString(), endsWith('/v1/chat/completions'));
    expect(transport.headers, isNot(contains('authorization')));
    expect(secrets.reads, 0);
    expect(transport.body, contains('"type":"json_schema"'));
    expect(transport.body, isNot(contains('敏感姓名')));
  });

  test(
    'remote provider performs zero network before per-meeting consent',
    () async {
      final transport = _Transport(_successEnvelope());
      final provider = OpenAiCompatibleDesktopMeetingAiProvider(
        providerId: 'openai-compatible',
        displayName: 'OpenAI-compatible',
        modelId: 'meeting-model',
        endpoint: DesktopAiEndpoint.parse('https://ai.example.com'),
        secretStore: _SecretStore(secret: 'sk-test'),
        requiresSecret: true,
        transport: transport,
      );

      await expectLater(
        MeetingAiWorkflow(
          provider: provider,
        ).generate(_request(MeetingAiConsent.denied)),
        throwsA(
          isA<MeetingAiFailure>().having(
            (failure) => failure.code,
            'code',
            MeetingAiFailureCode.consentRequired,
          ),
        ),
      );
      final availability = await provider.probeAvailability();
      expect(availability.available, isTrue);
      expect(transport.calls, 0);
    },
  );

  test('workflow rejects evidence outside the selected transcript', () async {
    final transport = _Transport(_successEnvelope(segmentId: 999));
    final provider = OpenAiCompatibleDesktopMeetingAiProvider(
      providerId: 'openai-compatible',
      displayName: 'OpenAI-compatible',
      modelId: 'meeting-model',
      endpoint: DesktopAiEndpoint.parse('https://ai.example.com'),
      secretStore: _SecretStore(secret: 'sk-test'),
      requiresSecret: true,
      transport: transport,
    );

    await expectLater(
      MeetingAiWorkflow(
        provider: provider,
      ).generate(_request(MeetingAiConsent.granted)),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.invalidOutput,
        ),
      ),
    );
  });
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

DesktopOpenAiHttpResponse _successEnvelope({int segmentId = 41}) {
  final content = jsonEncode(<String, Object?>{
    'schema_version': 'meeting_intelligence_output/v1',
    'suggested_title': '发布会',
    'meeting_type': 'planning',
    'items': <Object?>[
      <String, Object?>{
        'kind': 'decision',
        'body': '下周一发布。',
        'action_owner': null,
        'action_due_at_ms': null,
        'evidence': <Object?>[
          <String, Object?>{
            'segment_id': segmentId,
            'start_ms': 1000,
            'end_ms': 2500,
          },
        ],
      },
    ],
  });
  return DesktopOpenAiHttpResponse(
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

class _Transport implements DesktopOpenAiHttpTransport {
  _Transport(this.response);

  final DesktopOpenAiHttpResponse response;
  int calls = 0;
  Uri? uri;
  Map<String, String>? headers;
  String? body;

  @override
  Future<DesktopOpenAiHttpResponse> get({
    required Uri uri,
    required Map<String, String> headers,
  }) async {
    calls += 1;
    this.uri = uri;
    this.headers = headers;
    return DesktopOpenAiHttpResponse(
      200,
      jsonEncode(<String, Object?>{
        'data': <Object?>[
          <String, Object?>{'id': 'qwen3:8b'},
        ],
      }),
    );
  }

  @override
  Future<DesktopOpenAiHttpResponse> post({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    calls += 1;
    this.uri = uri;
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
  Future<void> delete(String providerId) async => secret = null;

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
