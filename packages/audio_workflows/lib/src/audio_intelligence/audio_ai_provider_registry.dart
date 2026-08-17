import 'audio_ai_provider.dart';

class AudioAiProviderRegistry {
  AudioAiProviderRegistry(Iterable<AudioAiProviderPort> providers)
    : _providers = _index(providers);

  final Map<String, AudioAiProviderPort> _providers;

  List<AudioAiProviderDescriptor> get descriptors =>
      _providers.values.map(audioAiDescriptorOf).toList(growable: false);

  AudioAiProviderPort resolve(String providerId) {
    final provider = _providers[providerId];
    if (provider == null) {
      throw AudioAiFailure(
        AudioAiFailureCode.providerMissing,
        '未找到音频智能提供商：$providerId',
      );
    }
    return provider;
  }

  static Map<String, AudioAiProviderPort> _index(
    Iterable<AudioAiProviderPort> providers,
  ) {
    final indexed = <String, AudioAiProviderPort>{};
    for (final provider in providers) {
      final id = provider.providerId.trim();
      if (!RegExp(r'^[a-z0-9][a-z0-9._-]{1,63}$').hasMatch(id)) {
        throw ArgumentError.value(provider.providerId, 'providerId');
      }
      if (indexed.containsKey(id)) {
        throw ArgumentError('Duplicate audio AI provider: $id');
      }
      indexed[id] = provider;
    }
    return Map<String, AudioAiProviderPort>.unmodifiable(indexed);
  }
}
