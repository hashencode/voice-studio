import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/deepseek_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_http_client.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_validator.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test(
    'sends bounded JSON-mode request and parses only final content',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final content = File(
        'test/fixtures/meeting_intelligence/valid_output_v1.json',
      ).readAsStringSync();
      final transport = _FakeTransport(
        response: _successResponse(
          content,
          reasoningContent: 'private reasoning must be discarded',
        ),
      );
      final provider = DeepSeekMeetingIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: transport,
        secretLoader: () async => 'fixture-secret-value',
        maximumOutputTokens: 512,
      );

      final output = await provider.generate(_cloudRequest(fixture.request));

      expect(output.items, hasLength(MeetingInsightKind.values.length));
      expect(output.suggestedTitle, 'S3 交付周会');
      final request = transport.requests.single;
      expect(
        request.uri,
        Uri.parse('https://api.deepseek.com/chat/completions'),
      );
      expect(request.headers['authorization'], 'Bearer fixture-secret-value');
      final body = jsonDecode(request.body) as Map<String, Object?>;
      expect(body['model'], 'deepseek-v4-flash');
      expect(body['stream'], isFalse);
      expect(body['max_tokens'], 512);
      expect(body['response_format'], <String, Object?>{'type': 'json_object'});
      expect(body['thinking'], <String, Object?>{'type': 'disabled'});
      expect(body.containsKey('tools'), isFalse);
      expect(output.toString(), isNot(contains('private reasoning')));
    },
  );

  test(
    'empty, malformed, unknown-version and truncated output fail atomically',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final request = _cloudRequest(fixture.request);
      final cases = <MeetingIntelligenceHttpResponse>[
        _successResponse(''),
        _successResponse('{not-json'),
        _successResponse(
          File(
            'test/fixtures/meeting_intelligence/unknown_schema.json',
          ).readAsStringSync(),
        ),
        _successResponse(
          '{"schema_version":"meeting_intelligence_output/v1","items":[]}',
          finishReason: 'length',
        ),
      ];

      for (final response in cases) {
        final provider = DeepSeekMeetingIntelligenceProvider(
          modelId: 'deepseek-v4-flash',
          transport: _FakeTransport(response: response),
          secretLoader: () async => 'fixture-secret-value',
        );
        await _expectFailure(
          provider.generate(request),
          MeetingIntelligenceFailureCode.responseInvalid,
        );
      }
    },
  );

  test('maps provider status to actionable sanitized codes', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final expected = <int, MeetingIntelligenceFailureCode>{
      401: MeetingIntelligenceFailureCode.unauthorized,
      402: MeetingIntelligenceFailureCode.paymentRequired,
      429: MeetingIntelligenceFailureCode.rateLimited,
      500: MeetingIntelligenceFailureCode.serviceUnavailable,
      503: MeetingIntelligenceFailureCode.serviceUnavailable,
    };

    for (final entry in expected.entries) {
      final provider = DeepSeekMeetingIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: _FakeTransport(
          response: MeetingIntelligenceHttpResponse(
            statusCode: entry.key,
            body: 'fixture-secret-value Authorization Bearer raw-error',
          ),
        ),
        secretLoader: () async => 'fixture-secret-value',
      );
      final failure = await _expectFailure(
        provider.generate(_cloudRequest(fixture.request)),
        entry.value,
      );
      expect(failure.toString(), isNot(contains('fixture-secret-value')));
      expect(failure.userMessage, isNot(contains('Authorization')));
      expect(failure.userMessage, isNot(contains('Bearer')));
      expect(failure.userMessage, isNot(contains('raw-error')));
    }
  });

  test('missing secret and cancellation produce no completed output', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final missingSecretTransport = _FakeTransport(
      response: _successResponse(
        '{"schema_version":"meeting_intelligence_output/v1","items":[]}',
      ),
    );
    final withoutSecret = DeepSeekMeetingIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      transport: missingSecretTransport,
      secretLoader: () async => null,
    );
    await _expectFailure(
      withoutSecret.generate(_cloudRequest(fixture.request)),
      MeetingIntelligenceFailureCode.secretUnavailable,
    );
    expect(missingSecretTransport.requests, isEmpty);

    final token = MeetingIntelligenceCancellationToken();
    final cancellationTransport = _FakeTransport(
      handler: (request, cancellationToken) {
        final completer = Completer<MeetingIntelligenceHttpResponse>();
        cancellationToken!.addListener(() {
          completer.completeError(
            const MeetingIntelligenceProviderException(
              MeetingIntelligenceFailureCode.canceled,
              '生成已取消',
            ),
          );
        });
        return completer.future;
      },
    );
    final provider = DeepSeekMeetingIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      transport: cancellationTransport,
      secretLoader: () async => 'fixture-secret-value',
    );
    final future = provider.generate(
      _cloudRequest(fixture.request),
      cancellationToken: token,
    );
    await Future<void>.delayed(Duration.zero);
    token.cancel();
    await _expectFailure(future, MeetingIntelligenceFailureCode.canceled);
    expect(cancellationTransport.requests, hasLength(1));
  });

  test(
    'invalid evidence is sanitized and retained only as unsupported draft',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final request = _cloudRequest(fixture.request);
      final content = jsonEncode(<String, Object?>{
        'schema_version': 'meeting_intelligence_output/v1',
        'items': <Object?>[
          <String, Object?>{
            'kind': 'decision',
            'body': 'Invented decision',
            'evidence': <Object?>[
              <String, Object?>{
                'segment_id': 999999,
                'start_ms': 1,
                'end_ms': 2,
              },
            ],
          },
        ],
      });
      final provider = DeepSeekMeetingIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: _FakeTransport(response: _successResponse(content)),
        secretLoader: () async => 'fixture-secret-value',
      );

      final output = await provider.generate(request);
      final validated = const MeetingIntelligenceValidator().validate(
        request: request,
        output: output,
      );

      expect(validated.items.single.unsupported, isTrue);
      expect(validated.items.single.candidate.evidence, isEmpty);
    },
  );

  test(
    'HTTP client rejects non-HTTPS or non-allowlisted hosts before I/O',
    () async {
      final client = MeetingIntelligenceHttpClient();
      for (final uri in <Uri>[
        Uri.parse('http://api.deepseek.com/chat/completions'),
        Uri.parse('https://example.invalid/chat/completions'),
      ]) {
        final failure = await _expectFailure(
          client.send(
            MeetingIntelligenceHttpRequest(
              uri: uri,
              headers: const <String, String>{},
              body: '{}',
            ),
          ),
          MeetingIntelligenceFailureCode.networkUnavailable,
        );
        expect(failure.userMessage, isNot(contains(uri.host)));
      }
    },
  );

  test('bounded transport failure is sanitized and propagated', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = DeepSeekMeetingIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      transport: _FakeTransport(
        handler: (request, cancellationToken) {
          throw const MeetingIntelligenceProviderException(
            MeetingIntelligenceFailureCode.responseTooLarge,
            '云端结果超过安全大小限制',
          );
        },
      ),
      secretLoader: () async => 'fixture-secret-value',
    );

    final failure = await _expectFailure(
      provider.generate(_cloudRequest(fixture.request)),
      MeetingIntelligenceFailureCode.responseTooLarge,
    );
    expect(failure.toString(), isNot(contains('fixture-secret-value')));
  });
}

MeetingIntelligenceRequest _cloudRequest(MeetingIntelligenceRequest source) {
  return MeetingIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: MeetingProcessingLocation.cloudDirect,
    consentDecision: MeetingConsentDecision.granted,
    inputStartMs: source.inputStartMs,
    inputEndMs: source.inputEndMs,
    segments: source.segments,
    consentAtMs: 123,
    payloadSummary: 'synthetic fixture',
  );
}

MeetingIntelligenceHttpResponse _successResponse(
  String content, {
  String finishReason = 'stop',
  String? reasoningContent,
}) {
  return MeetingIntelligenceHttpResponse(
    statusCode: 200,
    body: jsonEncode(<String, Object?>{
      'choices': <Object?>[
        <String, Object?>{
          'finish_reason': finishReason,
          'message': <String, Object?>{
            'content': content,
            'reasoning_content': reasoningContent,
          },
        },
      ],
    }),
  );
}

Future<MeetingIntelligenceProviderException> _expectFailure(
  Future<Object?> future,
  MeetingIntelligenceFailureCode code,
) async {
  try {
    await future;
    fail('Expected MeetingIntelligenceProviderException');
  } on MeetingIntelligenceProviderException catch (error) {
    expect(error.code, code);
    return error;
  }
}

typedef _TransportHandler =
    Future<MeetingIntelligenceHttpResponse> Function(
      MeetingIntelligenceHttpRequest request,
      MeetingIntelligenceCancellationToken? cancellationToken,
    );

class _FakeTransport implements MeetingIntelligenceHttpTransport {
  _FakeTransport({this.response, this.handler});

  final MeetingIntelligenceHttpResponse? response;
  final _TransportHandler? handler;
  final List<MeetingIntelligenceHttpRequest> requests =
      <MeetingIntelligenceHttpRequest>[];

  @override
  Future<MeetingIntelligenceHttpResponse> send(
    MeetingIntelligenceHttpRequest request, {
    MeetingIntelligenceCancellationToken? cancellationToken,
  }) async {
    requests.add(request);
    final callback = handler;
    if (callback != null) {
      return callback(request, cancellationToken);
    }
    return response!;
  }
}
