import '../meeting_workspace/meeting_workspace_models.dart';

enum MeetingAiConsent { denied, granted }

enum MeetingAiProcessingLocation { localEndpoint, cloudDirect }

enum MeetingAiFailureCode {
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

class MeetingAiFailure implements Exception {
  const MeetingAiFailure(this.code, this.message);

  final MeetingAiFailureCode code;
  final String message;

  @override
  String toString() => 'MeetingAiFailure(${code.name})';
}

class MeetingAiProviderDescriptor {
  const MeetingAiProviderDescriptor({
    required this.providerId,
    required this.displayName,
    required this.processingLocation,
    required this.requiresSecret,
  });

  final String providerId;
  final String displayName;
  final MeetingAiProcessingLocation processingLocation;
  final bool requiresSecret;

  bool get requiresMeetingConsent =>
      processingLocation == MeetingAiProcessingLocation.cloudDirect;
}

class MeetingAiAvailability {
  const MeetingAiAvailability.available() : available = true, failure = null;

  const MeetingAiAvailability.unavailable(this.failure) : available = false;

  final bool available;
  final MeetingAiFailure? failure;
}

class MeetingAiCancellationToken {
  bool _canceled = false;

  bool get isCanceled => _canceled;

  void cancel() => _canceled = true;

  void throwIfCanceled() {
    if (_canceled) {
      throw const MeetingAiFailure(MeetingAiFailureCode.canceled, '会议笔记生成已取消');
    }
  }
}

class MeetingAiEvidence {
  const MeetingAiEvidence({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
}

class MeetingAiInsight {
  const MeetingAiInsight({
    required this.kind,
    required this.body,
    required this.evidence,
    this.actionOwner,
    this.actionDueAtMs,
  });

  final String kind;
  final String body;
  final List<MeetingAiEvidence> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
}

class MeetingAiOutput {
  const MeetingAiOutput({
    required this.insights,
    this.schemaVersion = 'meeting_intelligence_output/v1',
    this.suggestedTitle,
    this.meetingType,
  });

  final String schemaVersion;
  final String? suggestedTitle;
  final String? meetingType;
  final List<MeetingAiInsight> insights;
}

class MeetingAiRequest {
  const MeetingAiRequest({
    required this.recordingId,
    required this.generationId,
    required this.consent,
    required this.segments,
    required this.meetingTitle,
    this.templateId = 'general',
  });

  final int recordingId;
  final int generationId;
  final MeetingAiConsent consent;
  final List<MeetingWorkspaceSegment> segments;
  final String meetingTitle;
  final String templateId;
}

abstract interface class MeetingAiProviderPort {
  String get providerId;
  String get modelId;

  Future<bool> isConfigured();

  Future<MeetingAiOutput> generate(MeetingAiRequest request);
}

/// Optional richer contract used by the desktop provider registry.
///
/// Keeping this separate preserves source compatibility for the mobile
/// adapters while desktop providers expose location, availability and cancel.
abstract interface class MeetingAiExtendedProviderPort
    implements MeetingAiProviderPort {
  MeetingAiProviderDescriptor get descriptor;

  Future<MeetingAiAvailability> probeAvailability();

  Future<void> cancel();
}

MeetingAiProviderDescriptor meetingAiDescriptorOf(
  MeetingAiProviderPort provider,
) {
  if (provider is MeetingAiExtendedProviderPort) return provider.descriptor;
  return MeetingAiProviderDescriptor(
    providerId: provider.providerId,
    displayName: provider.providerId,
    processingLocation: MeetingAiProcessingLocation.cloudDirect,
    requiresSecret: true,
  );
}
