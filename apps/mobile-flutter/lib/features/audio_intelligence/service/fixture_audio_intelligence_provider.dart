import '../model/audio_insight_entity.dart';
import 'audio_intelligence_provider.dart';

class FixtureAudioIntelligenceProvider implements AudioIntelligenceProvider {
  FixtureAudioIntelligenceProvider({required this.output});

  final AudioIntelligenceOutput output;
  int invocationCount = 0;

  @override
  AudioIntelligenceCapabilities get capabilities =>
      const AudioIntelligenceCapabilities(
        processingLocations: <AudioProcessingLocation>{
          AudioProcessingLocation.onDevice,
        },
        supportedKinds: <AudioInsightKind>{
          AudioInsightKind.title,
          AudioInsightKind.summary,
          AudioInsightKind.summaryKeyPoint,
          AudioInsightKind.summaryDetailed,
          AudioInsightKind.topic,
          AudioInsightKind.decision,
          AudioInsightKind.action,
          AudioInsightKind.risk,
          AudioInsightKind.unresolved,
        },
      );

  @override
  String get modelId => 'fixture-v1';

  @override
  String get providerId => 'fixture-local';

  @override
  Future<AudioIntelligenceOutput> generate(
    AudioIntelligenceRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    invocationCount++;
    return output;
  }
}
