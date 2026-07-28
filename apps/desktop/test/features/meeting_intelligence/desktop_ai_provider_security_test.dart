import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/meeting_intelligence/openai_compatible_desktop_provider.dart';
import 'package:voice2text_desktop/features/secrets/desktop_secret_store.dart';
import 'package:voice2text_desktop/features/settings/desktop_ai_provider_settings_repository.dart';
import 'package:voice2text_desktop/features/settings/desktop_secure_settings.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test('endpoint policy rejects remote HTTP, userinfo and non-loopback IP', () {
    for (final endpoint in <String>[
      'http://ai.example.com',
      'https://user:secret@ai.example.com',
      'https://192.168.1.5',
      'file://localhost/tmp/model',
    ]) {
      expect(
        () => DesktopAiEndpoint.parse(endpoint),
        throwsA(
          isA<MeetingAiFailure>().having(
            (failure) => failure.code,
            'code',
            MeetingAiFailureCode.invalidConfiguration,
          ),
        ),
        reason: endpoint,
      );
    }
    expect(
      DesktopAiEndpoint.parse('http://localhost:11434').isLoopback,
      isTrue,
    );
  });

  test('product settings expose only preset and remote custom providers', () {
    expect(
      () => const DesktopAiProviderSettings(
        providerId: 'ollama',
        modelId: 'local-model',
        endpoint: 'http://127.0.0.1:11434',
      ).validated(),
      throwsArgumentError,
    );
    expect(
      () => const DesktopAiProviderSettings(
        providerId: 'openai-compatible',
        modelId: 'meeting-model',
        endpoint: 'http://127.0.0.1:11434',
      ).validated(),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.invalidConfiguration,
        ),
      ),
    );
  });

  test('bounded transport rejects redirects and oversized responses', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var oversized = false;
    server.listen((request) async {
      if (oversized) {
        request.response.add(List<int>.filled(1025, 65));
      } else {
        request.response
          ..statusCode = HttpStatus.found
          ..headers.set(HttpHeaders.locationHeader, 'https://evil.example');
      }
      await request.response.close();
    });
    final endpoint = DesktopAiEndpoint.parse('http://127.0.0.1:${server.port}');
    final transport = DesktopOpenAiBoundedHttpTransport(
      allowedEndpoint: endpoint,
      maximumResponseBytes: 1024,
    );

    await expectLater(
      transport.post(
        uri: endpoint.chatCompletionsUri,
        headers: const <String, String>{},
        body: '{}',
      ),
      throwsA(isA<MeetingAiFailure>()),
    );
    oversized = true;
    await expectLater(
      transport.post(
        uri: endpoint.chatCompletionsUri,
        headers: const <String, String>{},
        body: '{}',
      ),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.responseTooLarge,
        ),
      ),
    );
  });

  test(
    'loopback mock server completes generic structured HTTP smoke',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var requests = 0;
      server.listen((request) async {
        requests += 1;
        expect(request.headers.value(HttpHeaders.authorizationHeader), isNull);
        if (request.uri.path == '/v1/models') {
          request.response.headers.contentType = ContentType.json;
          request.response.write(
            jsonEncode(<String, Object?>{
              'data': <Object?>[
                <String, Object?>{'id': 'qwen3:8b'},
              ],
            }),
          );
          await request.response.close();
          return;
        }
        expect(request.uri.path, '/v1/chat/completions');
        final bytes = <int>[];
        await for (final chunk in request) {
          bytes.addAll(chunk);
        }
        final body = utf8.decode(bytes);
        expect(body, contains('"type":"json_schema"'));
        request.response.headers.contentType = ContentType.json;
        request.response.write(_successEnvelope());
        await request.response.close();
      });
      final provider = _loopbackContractProvider(server.port);

      final availability = await provider.probeAvailability();
      final output = await MeetingAiWorkflow(
        provider: provider,
      ).generate(_request());

      expect(availability.available, isTrue);
      expect(requests, 2);
      expect(output.insights.single.body, '下周发布');
    },
  );

  test('loopback availability rejects a missing configured model', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode(<String, Object?>{
          'data': <Object?>[
            <String, Object?>{'id': 'another-model'},
          ],
        }),
      );
      await request.response.close();
    });
    final provider = _loopbackContractProvider(server.port);

    final availability = await provider.probeAvailability();

    expect(availability.available, isFalse);
    expect(
      availability.failure?.code,
      MeetingAiFailureCode.invalidConfiguration,
    );
  });

  test('provider bounds concurrency and cancels the live request', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final requestArrived = Completer<void>();
    server.listen((request) async {
      if (!requestArrived.isCompleted) requestArrived.complete();
      await request.drain<void>();
      // Keep the response open until the client cancels it.
    });
    final provider = _loopbackContractProvider(server.port);

    final generation = provider.generate(_request());
    final expectation = expectLater(
      generation,
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.canceled,
        ),
      ),
    );
    await requestArrived.future.timeout(const Duration(seconds: 3));
    await expectLater(
      provider.generate(_request()),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.serviceUnavailable,
        ),
      ),
    );
    await provider.cancel();

    await expectation;
  });

  test('provider settings persist no key material in SQLite', () async {
    final root = await Directory.systemTemp.createTemp('ai-settings-test-');
    addTearDown(() => root.delete(recursive: true));
    final owner = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'settings.db',
    );
    final repository = DesktopAiProviderSettingsRepository(database: owner);
    const secret = 'sk-do-not-persist-123456';

    await repository.save(
      const DesktopAiProviderSettings(
        providerId: 'openai-compatible',
        modelId: 'meeting-model',
        endpoint: 'https://ai.example.com',
      ),
    );
    final loaded = await repository.load();
    expect(loaded.providerId, 'openai-compatible');
    expect(loaded.endpoint, 'https://ai.example.com');
    await (await owner.database).close();

    final bytes = await File(p.join(root.path, 'settings.db')).readAsBytes();
    expect(String.fromCharCodes(bytes), isNot(contains(secret)));
    expect(String.fromCharCodes(bytes), isNot(contains('meeting_ai_api_key')));
  });

  test('secure settings replacement and deletion leave no old value', () async {
    final store = _MemorySecretStore();
    final settings = DesktopSecureSettings.withStore(store);

    await settings.writeProviderSecret('openai-compatible', 'old-secret');
    await settings.writeProviderSecret('openai-compatible', 'new-secret');
    expect(
      await settings.readProviderSecret('openai-compatible'),
      'new-secret',
    );
    expect(store.values.values, isNot(contains('old-secret')));

    await settings.deleteProviderSecret('openai-compatible');
    expect(await settings.readProviderSecret('openai-compatible'), isNull);
  });
}

OpenAiCompatibleDesktopMeetingAiProvider _loopbackContractProvider(int port) {
  return OpenAiCompatibleDesktopMeetingAiProvider(
    providerId: 'loopback-contract-test',
    displayName: 'Loopback contract test',
    modelId: 'qwen3:8b',
    endpoint: DesktopAiEndpoint.parse('http://127.0.0.1:$port'),
    secretStore: _MemorySecretStore(),
    requiresSecret: false,
  );
}

MeetingAiRequest _request() => const MeetingAiRequest(
  recordingId: 1,
  generationId: 1,
  consent: MeetingAiConsent.denied,
  segments: <MeetingWorkspaceSegment>[
    MeetingWorkspaceSegment(
      id: 7,
      sequenceId: 0,
      text: '下周发布',
      startMs: 0,
      endMs: 1000,
      reviewState: MeetingWorkspaceReviewState.reviewed,
      speakerState: MeetingWorkspaceSpeakerState.unknown,
      speakerId: null,
      speakerName: null,
      speakerSource: null,
    ),
  ],
  meetingTitle: '本机 smoke',
);

String _successEnvelope() {
  return '''
{"choices":[{"finish_reason":"stop","message":{"content":"{\\"schema_version\\":\\"meeting_intelligence_output/v1\\",\\"suggested_title\\":null,\\"meeting_type\\":null,\\"items\\":[{\\"kind\\":\\"decision\\",\\"body\\":\\"下周发布\\",\\"evidence\\":[{\\"segment_id\\":7,\\"start_ms\\":0,\\"end_ms\\":1000}],\\"action_owner\\":null,\\"action_due_at_ms\\":null}]}"}}]}
''';
}

class _MemorySecretStore implements DesktopSecretStore {
  final Map<String, String> values = <String, String>{};

  @override
  Future<bool> contains(String providerId) async =>
      values[providerId]?.isNotEmpty == true;

  @override
  Future<void> delete(String providerId) async => values.remove(providerId);

  @override
  Future<String?> read(String providerId) async => values[providerId];

  @override
  Future<void> replace(String providerId, String secret) async {
    values[providerId] = secret;
  }
}
