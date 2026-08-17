import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/deepseek_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_http_client.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_validator.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test(
    'sends bounded JSON-mode request and parses only final content',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final content = File(
        'test/fixtures/audio_intelligence/valid_output_v1.json',
      ).readAsStringSync();
      final transport = _FakeTransport(
        response: _successResponse(
          content,
          reasoningContent: 'private reasoning must be discarded',
        ),
      );
      final provider = DeepSeekAudioIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: transport,
        secretLoader: () async => 'fixture-secret-value',
        maximumOutputTokens: 512,
      );

      final output = await provider.generate(_cloudRequest(fixture.request));

      expect(output.items, hasLength(AudioInsightKind.values.length));
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
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final request = _cloudRequest(fixture.request);
      final cases = <AudioIntelligenceHttpResponse>[
        _successResponse(''),
        _successResponse('{not-json'),
        _successResponse(
          File(
            'test/fixtures/audio_intelligence/unknown_schema.json',
          ).readAsStringSync(),
        ),
        _successResponse(
          '{"schema_version":"audio_intelligence_output/v1","items":[]}',
          finishReason: 'length',
        ),
      ];

      for (final response in cases) {
        final provider = DeepSeekAudioIntelligenceProvider(
          modelId: 'deepseek-v4-flash',
          transport: _FakeTransport(response: response),
          secretLoader: () async => 'fixture-secret-value',
        );
        await _expectFailure(
          provider.generate(request),
          AudioIntelligenceFailureCode.responseInvalid,
        );
      }
    },
  );

  test('maps provider status to actionable sanitized codes', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final expected = <int, AudioIntelligenceFailureCode>{
      401: AudioIntelligenceFailureCode.unauthorized,
      402: AudioIntelligenceFailureCode.paymentRequired,
      429: AudioIntelligenceFailureCode.rateLimited,
      500: AudioIntelligenceFailureCode.serviceUnavailable,
      503: AudioIntelligenceFailureCode.serviceUnavailable,
    };

    for (final entry in expected.entries) {
      final provider = DeepSeekAudioIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: _FakeTransport(
          response: AudioIntelligenceHttpResponse(
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
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final missingSecretTransport = _FakeTransport(
      response: _successResponse(
        '{"schema_version":"audio_intelligence_output/v1","items":[]}',
      ),
    );
    final withoutSecret = DeepSeekAudioIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      transport: missingSecretTransport,
      secretLoader: () async => null,
    );
    await _expectFailure(
      withoutSecret.generate(_cloudRequest(fixture.request)),
      AudioIntelligenceFailureCode.secretUnavailable,
    );
    expect(missingSecretTransport.requests, isEmpty);

    final token = AudioIntelligenceCancellationToken();
    final cancellationTransport = _FakeTransport(
      handler: (request, cancellationToken) {
        final completer = Completer<AudioIntelligenceHttpResponse>();
        cancellationToken!.addListener(() {
          completer.completeError(
            const AudioIntelligenceProviderException(
              AudioIntelligenceFailureCode.canceled,
              '生成已取消',
            ),
          );
        });
        return completer.future;
      },
    );
    final provider = DeepSeekAudioIntelligenceProvider(
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
    await _expectFailure(future, AudioIntelligenceFailureCode.canceled);
    expect(cancellationTransport.requests, hasLength(1));
  });

  test(
    'invalid evidence is sanitized and retained only as unsupported draft',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final request = _cloudRequest(fixture.request);
      final content = jsonEncode(<String, Object?>{
        'schema_version': 'audio_intelligence_output/v1',
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
      final provider = DeepSeekAudioIntelligenceProvider(
        modelId: 'deepseek-v4-flash',
        transport: _FakeTransport(response: _successResponse(content)),
        secretLoader: () async => 'fixture-secret-value',
      );

      final output = await provider.generate(request);
      final validated = const AudioIntelligenceValidator().validate(
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
      final client = AudioIntelligenceHttpClient();
      for (final uri in <Uri>[
        Uri.parse('http://api.deepseek.com/chat/completions'),
        Uri.parse('https://example.invalid/chat/completions'),
      ]) {
        final failure = await _expectFailure(
          client.send(
            AudioIntelligenceHttpRequest(
              uri: uri,
              headers: const <String, String>{},
              body: '{}',
            ),
          ),
          AudioIntelligenceFailureCode.networkUnavailable,
        );
        expect(failure.userMessage, isNot(contains(uri.host)));
      }
    },
  );

  test('bounded transport failure is sanitized and propagated', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = DeepSeekAudioIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      transport: _FakeTransport(
        handler: (request, cancellationToken) {
          throw const AudioIntelligenceProviderException(
            AudioIntelligenceFailureCode.responseTooLarge,
            '云端结果超过安全大小限制',
          );
        },
      ),
      secretLoader: () async => 'fixture-secret-value',
    );

    final failure = await _expectFailure(
      provider.generate(_cloudRequest(fixture.request)),
      AudioIntelligenceFailureCode.responseTooLarge,
    );
    expect(failure.toString(), isNot(contains('fixture-secret-value')));
  });
}

AudioIntelligenceRequest _cloudRequest(AudioIntelligenceRequest source) {
  return AudioIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: AudioProcessingLocation.cloudDirect,
    consentDecision: AudioConsentDecision.granted,
    inputStartMs: source.inputStartMs,
    inputEndMs: source.inputEndMs,
    segments: source.segments,
    consentAtMs: 123,
    payloadSummary: 'synthetic fixture',
  );
}

AudioIntelligenceHttpResponse _successResponse(
  String content, {
  String finishReason = 'stop',
  String? reasoningContent,
}) {
  return AudioIntelligenceHttpResponse(
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

Future<AudioIntelligenceProviderException> _expectFailure(
  Future<Object?> future,
  AudioIntelligenceFailureCode code,
) async {
  try {
    await future;
    fail('Expected AudioIntelligenceProviderException');
  } on AudioIntelligenceProviderException catch (error) {
    expect(error.code, code);
    return error;
  }
}

typedef _TransportHandler =
    Future<AudioIntelligenceHttpResponse> Function(
      AudioIntelligenceHttpRequest request,
      AudioIntelligenceCancellationToken? cancellationToken,
    );

class _FakeTransport implements AudioIntelligenceHttpTransport {
  _FakeTransport({this.response, this.handler});

  final AudioIntelligenceHttpResponse? response;
  final _TransportHandler? handler;
  final List<AudioIntelligenceHttpRequest> requests =
      <AudioIntelligenceHttpRequest>[];

  @override
  Future<AudioIntelligenceHttpResponse> send(
    AudioIntelligenceHttpRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  }) async {
    requests.add(request);
    final callback = handler;
    if (callback != null) {
      return callback(request, cancellationToken);
    }
    return response!;
  }
}
