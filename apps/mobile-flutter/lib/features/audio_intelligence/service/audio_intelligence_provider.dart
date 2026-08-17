import '../../transcription/model/transcript_segment_entity.dart';
import '../model/audio_insight_entity.dart';
import '../model/audio_template.dart';

enum AudioProcessingLocation {
  onDevice,
  cloudDirect,
  pairedPc;

  static AudioProcessingLocation fromStorage(Object? value) {
    return switch (value) {
      'local' => AudioProcessingLocation.onDevice,
      'remote' => AudioProcessingLocation.cloudDirect,
      _ => AudioProcessingLocation.values.firstWhere(
        (location) => location.name == value,
        orElse: () => AudioProcessingLocation.onDevice,
      ),
    };
  }
}

enum AudioConsentDecision { notRequested, denied, granted }

enum AudioIntelligenceFailureCode {
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

class AudioIntelligenceProviderException implements Exception {
  const AudioIntelligenceProviderException(this.code, this.userMessage);

  final AudioIntelligenceFailureCode code;
  final String userMessage;

  @override
  String toString() => 'AudioIntelligenceProviderException($code)';
}

class AudioIntelligenceCancellationToken {
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
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.canceled,
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

class AudioIntelligenceCapabilities {
  const AudioIntelligenceCapabilities({
    required this.processingLocations,
    required this.supportedKinds,
  });

  final Set<AudioProcessingLocation> processingLocations;
  final Set<AudioInsightKind> supportedKinds;
}

class AudioEvidenceCandidate {
  const AudioEvidenceCandidate({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
}

class AudioInsightCandidate {
  const AudioInsightCandidate({
    required this.kind,
    required this.body,
    this.evidence = const <AudioEvidenceCandidate>[],
    this.actionOwner,
    this.actionDueAtMs,
    this.resolutionState = AudioInsightResolutionState.notApplicable,
    this.topicStartMs,
    this.topicEndMs,
    this.sortOrder = 0,
  });

  final AudioInsightKind kind;
  final String body;
  final List<AudioEvidenceCandidate> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
  final AudioInsightResolutionState resolutionState;
  final int? topicStartMs;
  final int? topicEndMs;
  final int sortOrder;
}

class AudioIntelligenceOutput {
  const AudioIntelligenceOutput({
    required this.items,
    this.schemaVersion = 'audio_intelligence_output/v1',
    this.audioType,
    this.suggestedTitle,
  });

  final List<AudioInsightCandidate> items;
  final String schemaVersion;
  final String? audioType;
  final String? suggestedTitle;
}

class AudioIntelligenceRequest {
  const AudioIntelligenceRequest({
    required this.recordingId,
    required this.generationId,
    required this.processingLocation,
    required this.consentDecision,
    required this.inputStartMs,
    required this.inputEndMs,
    required this.segments,
    this.templateId = AudioTemplateId.general,
    this.consentVersion = 1,
    this.consentAtMs,
    this.payloadSummary,
    this.estimatedRequestCount = 1,
    this.speakerLabelsIncluded = false,
    this.reductionCandidates = const <AudioInsightCandidate>[],
  });

  final int recordingId;
  final int generationId;
  final AudioProcessingLocation processingLocation;
  final AudioConsentDecision consentDecision;
  final int inputStartMs;
  final int inputEndMs;
  final List<TranscriptSegmentEntity> segments;
  final AudioTemplateId templateId;
  final int consentVersion;
  final int? consentAtMs;
  final String? payloadSummary;
  final int estimatedRequestCount;
  final bool speakerLabelsIncluded;
  final List<AudioInsightCandidate> reductionCandidates;
}

abstract interface class AudioIntelligenceProvider {
  String get providerId;
  String get modelId;
  AudioIntelligenceCapabilities get capabilities;

  Future<AudioIntelligenceOutput> generate(
    AudioIntelligenceRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  });
}

class AudioIntelligenceProviderBoundary {
  const AudioIntelligenceProviderBoundary({
    this.provider,
    this.localOnly = true,
  });

  final AudioIntelligenceProvider? provider;
  final bool localOnly;

  Future<AudioIntelligenceOutput> generate(
    AudioIntelligenceRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  }) async {
    final selected = provider;
    if (selected == null) {
      throw StateError('未配置音频智能提供商');
    }
    if (request.consentDecision != AudioConsentDecision.granted) {
      throw StateError('未获得音频智能处理同意');
    }
    if (localOnly &&
        request.processingLocation != AudioProcessingLocation.onDevice) {
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
