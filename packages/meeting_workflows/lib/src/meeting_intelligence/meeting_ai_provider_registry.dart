import 'meeting_ai_provider.dart';

class MeetingAiProviderRegistry {
  MeetingAiProviderRegistry(Iterable<MeetingAiProviderPort> providers)
    : _providers = _index(providers);

  final Map<String, MeetingAiProviderPort> _providers;

  List<MeetingAiProviderDescriptor> get descriptors =>
      _providers.values.map(meetingAiDescriptorOf).toList(growable: false);

  MeetingAiProviderPort resolve(String providerId) {
    final provider = _providers[providerId];
    if (provider == null) {
      throw MeetingAiFailure(
        MeetingAiFailureCode.providerMissing,
        '未找到会议智能提供商：$providerId',
      );
    }
    return provider;
  }

  static Map<String, MeetingAiProviderPort> _index(
    Iterable<MeetingAiProviderPort> providers,
  ) {
    final indexed = <String, MeetingAiProviderPort>{};
    for (final provider in providers) {
      final id = provider.providerId.trim();
      if (!RegExp(r'^[a-z0-9][a-z0-9._-]{1,63}$').hasMatch(id)) {
        throw ArgumentError.value(provider.providerId, 'providerId');
      }
      if (indexed.containsKey(id)) {
        throw ArgumentError('Duplicate meeting AI provider: $id');
      }
      indexed[id] = provider;
    }
    return Map<String, MeetingAiProviderPort>.unmodifiable(indexed);
  }
}
