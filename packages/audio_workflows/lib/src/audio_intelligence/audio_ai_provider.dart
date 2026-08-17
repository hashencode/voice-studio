import '../audio_workspace/audio_workspace_models.dart';

enum AudioAiConsent { denied, granted }

enum AudioAiProcessingLocation { localEndpoint, cloudDirect }

enum AudioAiFailureCode {
  providerMissing,
  secretMissing,
  consentRequired,
  invalidConfiguration,
  invalidOutput,
  responseTooLarge,
  networkUnavailable,
  unauthorized,
  rateLimited,
  serviceUnavailable,
  canceled,
}

class AudioAiFailure implements Exception {
  const AudioAiFailure(this.code, this.message);

  final AudioAiFailureCode code;
  final String message;

  @override
  String toString() => 'AudioAiFailure(${code.name})';
}

class AudioAiProviderDescriptor {
  const AudioAiProviderDescriptor({
    required this.providerId,
    required this.displayName,
    required this.processingLocation,
    required this.requiresSecret,
  });

  final String providerId;
  final String displayName;
  final AudioAiProcessingLocation processingLocation;
  final bool requiresSecret;

  bool get requiresAudioConsent =>
      processingLocation == AudioAiProcessingLocation.cloudDirect;
}

class AudioAiAvailability {
  const AudioAiAvailability.available() : available = true, failure = null;

  const AudioAiAvailability.unavailable(this.failure) : available = false;

  final bool available;
  final AudioAiFailure? failure;
}

class AudioAiCancellationToken {
  bool _canceled = false;

  bool get isCanceled => _canceled;

  void cancel() => _canceled = true;

  void throwIfCanceled() {
    if (_canceled) {
      throw const AudioAiFailure(AudioAiFailureCode.canceled, '音频笔记生成已取消');
    }
  }
}

class AudioAiEvidence {
  const AudioAiEvidence({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
}

class AudioAiInsight {
  const AudioAiInsight({
    required this.kind,
    required this.body,
    required this.evidence,
    this.actionOwner,
    this.actionDueAtMs,
  });

  final String kind;
  final String body;
  final List<AudioAiEvidence> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
}

class AudioAiOutput {
  const AudioAiOutput({
    required this.insights,
    this.schemaVersion = 'audio_intelligence_output/v1',
    this.suggestedTitle,
    this.audioType,
  });

  final String schemaVersion;
  final String? suggestedTitle;
  final String? audioType;
  final List<AudioAiInsight> insights;
}

class AudioAiRequest {
  const AudioAiRequest({
    required this.recordingId,
    required this.generationId,
    required this.consent,
    required this.segments,
    required this.audioTitle,
    this.templateId = 'general',
  });

  final int recordingId;
  final int generationId;
  final AudioAiConsent consent;
  final List<AudioWorkspaceSegment> segments;
  final String audioTitle;
  final String templateId;
}

abstract interface class AudioAiProviderPort {
  String get providerId;
  String get modelId;

  Future<bool> isConfigured();

  Future<AudioAiOutput> generate(AudioAiRequest request);
}

/// Optional richer contract used by the desktop provider registry.
///
/// Keeping this separate preserves source compatibility for the mobile
/// adapters while desktop providers expose location, availability and cancel.
abstract interface class AudioAiExtendedProviderPort
    implements AudioAiProviderPort {
  AudioAiProviderDescriptor get descriptor;

  Future<AudioAiAvailability> probeAvailability();

  Future<void> cancel();
}

AudioAiProviderDescriptor audioAiDescriptorOf(AudioAiProviderPort provider) {
  if (provider is AudioAiExtendedProviderPort) return provider.descriptor;
  return AudioAiProviderDescriptor(
    providerId: provider.providerId,
    displayName: provider.providerId,
    processingLocation: AudioAiProcessingLocation.cloudDirect,
    requiresSecret: true,
  );
}
