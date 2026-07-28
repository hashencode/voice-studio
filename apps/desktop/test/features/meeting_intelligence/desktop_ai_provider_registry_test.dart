import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:voice2text_desktop/features/meeting_intelligence/desktop_ai_provider_registry.dart';
import 'package:voice2text_desktop/features/secrets/desktop_secret_store.dart';
import 'package:voice2text_desktop/features/settings/desktop_ai_provider_settings_repository.dart';

void main() {
  test('desktop registry resolves exactly the selected provider', () {
    final registry = DesktopAiProviderRegistry(secretStore: _SecretStore());

    final deepSeek = registry.resolve(DesktopAiProviderSettings.deepSeek);
    final open = registry.resolve(
      const DesktopAiProviderSettings(
        providerId: 'openai-compatible',
        modelId: 'meeting-model',
        endpoint: 'https://ai.example.com',
      ),
    );

    expect(deepSeek.providerId, 'deepseek');
    expect(open.providerId, 'openai-compatible');
    expect(
      meetingAiDescriptorOf(open).processingLocation,
      MeetingAiProcessingLocation.cloudDirect,
    );
  });

  test('shared registry rejects duplicates and never falls back', () {
    final provider = _Provider('deepseek');
    expect(
      () => MeetingAiProviderRegistry(<MeetingAiProviderPort>[
        provider,
        _Provider('deepseek'),
      ]),
      throwsArgumentError,
    );
    final registry = MeetingAiProviderRegistry(<MeetingAiProviderPort>[
      provider,
    ]);
    expect(
      () => registry.resolve('missing-provider'),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.providerMissing,
        ),
      ),
    );
    expect(provider.generateCalls, 0);
  });
}

class _Provider implements MeetingAiProviderPort {
  _Provider(this.providerId);

  @override
  final String providerId;
  int generateCalls = 0;

  @override
  String get modelId => 'test';

  @override
  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    generateCalls += 1;
    return const MeetingAiOutput(insights: <MeetingAiInsight>[]);
  }

  @override
  Future<bool> isConfigured() async => true;
}

class _SecretStore implements DesktopSecretStore {
  @override
  Future<bool> contains(String providerId) async => false;

  @override
  Future<void> delete(String providerId) async {}

  @override
  Future<String?> read(String providerId) async => null;

  @override
  Future<void> replace(String providerId, String secret) async {}
}
