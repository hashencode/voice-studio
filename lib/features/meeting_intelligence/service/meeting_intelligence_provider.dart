import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_insight_entity.dart';

enum MeetingProcessingLocation { local, remote }

enum MeetingConsentDecision { notRequested, denied, granted }

class MeetingIntelligenceCapabilities {
  const MeetingIntelligenceCapabilities({
    required this.processingLocations,
    required this.supportedKinds,
  });

  final Set<MeetingProcessingLocation> processingLocations;
  final Set<MeetingInsightKind> supportedKinds;
}

class MeetingEvidenceCandidate {
  const MeetingEvidenceCandidate({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
}

class MeetingInsightCandidate {
  const MeetingInsightCandidate({
    required this.kind,
    required this.body,
    this.evidence = const <MeetingEvidenceCandidate>[],
    this.actionOwner,
    this.actionDueAtMs,
  });

  final MeetingInsightKind kind;
  final String body;
  final List<MeetingEvidenceCandidate> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
}

class MeetingIntelligenceOutput {
  const MeetingIntelligenceOutput({required this.items});

  final List<MeetingInsightCandidate> items;
}

class MeetingIntelligenceRequest {
  const MeetingIntelligenceRequest({
    required this.recordingId,
    required this.generationId,
    required this.processingLocation,
    required this.consentDecision,
    required this.inputStartMs,
    required this.inputEndMs,
    required this.segments,
  });

  final int recordingId;
  final int generationId;
  final MeetingProcessingLocation processingLocation;
  final MeetingConsentDecision consentDecision;
  final int inputStartMs;
  final int inputEndMs;
  final List<TranscriptSegmentEntity> segments;
}

abstract interface class MeetingIntelligenceProvider {
  String get providerId;
  String get modelId;
  MeetingIntelligenceCapabilities get capabilities;

  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request,
  );
}

class MeetingIntelligenceProviderBoundary {
  const MeetingIntelligenceProviderBoundary({
    this.provider,
    this.localOnly = true,
  });

  final MeetingIntelligenceProvider? provider;
  final bool localOnly;

  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request,
  ) async {
    final selected = provider;
    if (selected == null) {
      throw StateError('未配置会议智能提供商');
    }
    if (request.consentDecision != MeetingConsentDecision.granted) {
      throw StateError('未获得会议智能处理同意');
    }
    if (localOnly &&
        request.processingLocation == MeetingProcessingLocation.remote) {
      throw StateError('本地模式禁止远程处理');
    }
    if (!selected.capabilities.processingLocations.contains(
      request.processingLocation,
    )) {
      throw StateError('提供商不支持请求的处理位置');
    }
    final output = await selected.generate(request);
    if (output.items.any(
      (item) => !selected.capabilities.supportedKinds.contains(item.kind),
    )) {
      throw StateError('提供商返回了未声明支持的条目类型');
    }
    return output;
  }
}
