import 'package:meeting_workflows/meeting_workflows.dart';

import '../secrets/desktop_secret_store.dart';
import '../settings/desktop_ai_provider_settings_repository.dart';
import 'deepseek_desktop_provider.dart';
import 'openai_compatible_desktop_provider.dart';

class DesktopAiProviderRegistry {
  const DesktopAiProviderRegistry({required DesktopSecretStore secretStore})
    : _secretStore = secretStore;

  final DesktopSecretStore _secretStore;

  MeetingAiProviderPort resolve(DesktopAiProviderSettings settings) {
    final value = settings.validated();
    final provider = switch (value.providerId) {
      'deepseek' => DeepSeekDesktopMeetingAiProvider(
        secretStore: _secretStore,
        modelId: value.modelId,
      ),
      'openai-compatible' => OpenAiCompatibleDesktopMeetingAiProvider(
        providerId: value.providerId,
        displayName: value.displayName,
        modelId: value.modelId,
        endpoint: DesktopAiEndpoint.parse(value.endpoint),
        secretStore: _secretStore,
        requiresSecret: true,
      ),
      _ => throw MeetingAiFailure(
        MeetingAiFailureCode.providerMissing,
        '未找到会议智能提供商：${value.providerId}',
      ),
    };
    return MeetingAiProviderRegistry(<MeetingAiProviderPort>[
      provider,
    ]).resolve(value.providerId);
  }
}
