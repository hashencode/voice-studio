import '../model/meeting_insight_entity.dart';
import 'meeting_intelligence_provider.dart';

class FixtureMeetingIntelligenceProvider
    implements MeetingIntelligenceProvider {
  FixtureMeetingIntelligenceProvider({required this.output});

  final MeetingIntelligenceOutput output;
  int invocationCount = 0;

  @override
  MeetingIntelligenceCapabilities get capabilities =>
      const MeetingIntelligenceCapabilities(
        processingLocations: <MeetingProcessingLocation>{
          MeetingProcessingLocation.local,
        },
        supportedKinds: <MeetingInsightKind>{
          MeetingInsightKind.summary,
          MeetingInsightKind.decision,
          MeetingInsightKind.action,
          MeetingInsightKind.risk,
        },
      );

  @override
  String get modelId => 'fixture-v1';

  @override
  String get providerId => 'fixture-local';

  @override
  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request,
  ) async {
    invocationCount++;
    return output;
  }
}
