import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_insight_entity.dart';
import '../model/meeting_template.dart';

enum MeetingProcessingLocation {
  onDevice,
  cloudDirect,
  pairedPc;

  static MeetingProcessingLocation fromStorage(Object? value) {
    return switch (value) {
      'local' => MeetingProcessingLocation.onDevice,
      'remote' => MeetingProcessingLocation.cloudDirect,
      _ => MeetingProcessingLocation.values.firstWhere(
        (location) => location.name == value,
        orElse: () => MeetingProcessingLocation.onDevice,
      ),
    };
  }
}

enum MeetingConsentDecision { notRequested, denied, granted }

enum MeetingIntelligenceFailureCode {
  unauthorized,
  paymentRequired,
  rateLimited,
  serviceUnavailable,
  responseInvalid,
  responseTooLarge,
  canceled,
  networkUnavailable,
  secretUnavailable,
}

class MeetingIntelligenceProviderException implements Exception {
  const MeetingIntelligenceProviderException(this.code, this.userMessage);

  final MeetingIntelligenceFailureCode code;
  final String userMessage;

  @override
  String toString() => 'MeetingIntelligenceProviderException($code)';
}

class MeetingIntelligenceCancellationToken {
  bool _canceled = false;
  final List<void Function()> _listeners = <void Function()>[];

  bool get isCanceled => _canceled;

  void cancel() {
    if (_canceled) return;
    _canceled = true;
    final listeners = List<void Function()>.of(_listeners);
    _listeners.clear();
    for (final listener in listeners) {
      listener();
    }
  }

  void throwIfCanceled() {
    if (_canceled) {
      throw const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.canceled,
        '生成已取消',
      );
    }
  }

  void Function() addListener(void Function() listener) {
    if (_canceled) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }
}

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
    this.resolutionState = MeetingInsightResolutionState.notApplicable,
    this.topicStartMs,
    this.topicEndMs,
    this.sortOrder = 0,
  });

  final MeetingInsightKind kind;
  final String body;
  final List<MeetingEvidenceCandidate> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
  final MeetingInsightResolutionState resolutionState;
  final int? topicStartMs;
  final int? topicEndMs;
  final int sortOrder;
}

class MeetingIntelligenceOutput {
  const MeetingIntelligenceOutput({
    required this.items,
    this.schemaVersion = 'meeting_intelligence_output/v1',
    this.meetingType,
    this.suggestedTitle,
  });

  final List<MeetingInsightCandidate> items;
  final String schemaVersion;
  final String? meetingType;
  final String? suggestedTitle;
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
    this.templateId = MeetingTemplateId.general,
    this.consentVersion = 1,
    this.consentAtMs,
    this.payloadSummary,
    this.estimatedRequestCount = 1,
    this.speakerLabelsIncluded = false,
    this.reductionCandidates = const <MeetingInsightCandidate>[],
  });

  final int recordingId;
  final int generationId;
  final MeetingProcessingLocation processingLocation;
  final MeetingConsentDecision consentDecision;
  final int inputStartMs;
  final int inputEndMs;
  final List<TranscriptSegmentEntity> segments;
  final MeetingTemplateId templateId;
  final int consentVersion;
  final int? consentAtMs;
  final String? payloadSummary;
  final int estimatedRequestCount;
  final bool speakerLabelsIncluded;
  final List<MeetingInsightCandidate> reductionCandidates;
}

abstract interface class MeetingIntelligenceProvider {
  String get providerId;
  String get modelId;
  MeetingIntelligenceCapabilities get capabilities;

  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request, {
    MeetingIntelligenceCancellationToken? cancellationToken,
  });
}

class MeetingIntelligenceProviderBoundary {
  const MeetingIntelligenceProviderBoundary({
    this.provider,
    this.localOnly = true,
  });

  final MeetingIntelligenceProvider? provider;
  final bool localOnly;

  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request, {
    MeetingIntelligenceCancellationToken? cancellationToken,
  }) async {
    final selected = provider;
    if (selected == null) {
      throw StateError('未配置会议智能提供商');
    }
    if (request.consentDecision != MeetingConsentDecision.granted) {
      throw StateError('未获得会议智能处理同意');
    }
    if (localOnly &&
        request.processingLocation != MeetingProcessingLocation.onDevice) {
      throw StateError('本地模式禁止远程处理');
    }
    if (!selected.capabilities.processingLocations.contains(
      request.processingLocation,
    )) {
      throw StateError('提供商不支持请求的处理位置');
    }
    final output = await selected.generate(
      request,
      cancellationToken: cancellationToken,
    );
    if (output.items.any(
      (item) => !selected.capabilities.supportedKinds.contains(item.kind),
    )) {
      throw StateError('提供商返回了未声明支持的条目类型');
    }
    return output;
  }
}
