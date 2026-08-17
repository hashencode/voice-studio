import '../../meeting_intelligence/service/meeting_intelligence_provider.dart';

class AppSettings {
  AppSettings({
    required this.modelId,
    required this.autoTranscribe,
    this.enablePunctuation = true,
    required this.isDarkMode,
    this.recordingConsentVersion = 0,
    this.recordingConsentAcceptedAtMs,
    this.recentlyDeletedRetentionDays,
    this.retentionLastSuccessfulScanAtMs,
    this.meetingProcessingLocation = MeetingProcessingLocation.onDevice,
    this.meetingAiProviderId,
    this.meetingAiModelId,
    this.meetingAiSecretConfigured = false,
  });

  final String modelId;
  final bool autoTranscribe;
  final bool enablePunctuation;
  final bool isDarkMode;
  final int recordingConsentVersion;
  final int? recordingConsentAcceptedAtMs;
  final int? recentlyDeletedRetentionDays;
  final int? retentionLastSuccessfulScanAtMs;
  final MeetingProcessingLocation meetingProcessingLocation;
  final String? meetingAiProviderId;
  final String? meetingAiModelId;
  final bool meetingAiSecretConfigured;

  static const String supportedModelId = 'paraformer-zh';
  static const String supportedRecordingMode = 'standard';
  static const List<int> supportedRetentionDays = <int>[7, 30, 90];

  static AppSettings defaults() {
    return AppSettings(
      modelId: supportedModelId,
      autoTranscribe: true,
      enablePunctuation: true,
      isDarkMode: false,
      recordingConsentVersion: 0,
      meetingProcessingLocation: MeetingProcessingLocation.onDevice,
    );
  }

  static AppSettings fromStorage({
    required String? modelId,
    required bool autoTranscribe,
    bool enablePunctuation = true,
    required bool isDarkMode,
    int recordingConsentVersion = 0,
    int? recordingConsentAcceptedAtMs,
    int? recentlyDeletedRetentionDays,
    int? retentionLastSuccessfulScanAtMs,
    Object? meetingProcessingLocation,
    String? meetingAiProviderId,
    String? meetingAiModelId,
    bool meetingAiSecretConfigured = false,
  }) {
    return AppSettings(
      modelId: modelId == supportedModelId ? modelId! : supportedModelId,
      autoTranscribe: autoTranscribe,
      enablePunctuation: enablePunctuation,
      isDarkMode: isDarkMode,
      recordingConsentVersion: recordingConsentVersion,
      recordingConsentAcceptedAtMs: recordingConsentAcceptedAtMs,
      recentlyDeletedRetentionDays:
          supportedRetentionDays.contains(recentlyDeletedRetentionDays)
          ? recentlyDeletedRetentionDays
          : null,
      retentionLastSuccessfulScanAtMs: retentionLastSuccessfulScanAtMs,
      meetingProcessingLocation: MeetingProcessingLocation.fromStorage(
        meetingProcessingLocation,
      ),
      meetingAiProviderId: _nonEmpty(meetingAiProviderId),
      meetingAiModelId: _nonEmpty(meetingAiModelId),
      meetingAiSecretConfigured: meetingAiSecretConfigured,
    );
  }

  static String normalizeRecordingMode(String? _) => supportedRecordingMode;

  AppSettings copyWith({
    String? modelId,
    bool? autoTranscribe,
    bool? enablePunctuation,
    bool? isDarkMode,
    int? recordingConsentVersion,
    int? recordingConsentAcceptedAtMs,
    int? recentlyDeletedRetentionDays,
    bool clearRecentlyDeletedRetention = false,
    int? retentionLastSuccessfulScanAtMs,
    MeetingProcessingLocation? meetingProcessingLocation,
    String? meetingAiProviderId,
    bool clearMeetingAiProvider = false,
    String? meetingAiModelId,
    bool clearMeetingAiModel = false,
    bool? meetingAiSecretConfigured,
  }) {
    return AppSettings(
      modelId: modelId ?? this.modelId,
      autoTranscribe: autoTranscribe ?? this.autoTranscribe,
      enablePunctuation: enablePunctuation ?? this.enablePunctuation,
      isDarkMode: isDarkMode ?? this.isDarkMode,
      recordingConsentVersion:
          recordingConsentVersion ?? this.recordingConsentVersion,
      recordingConsentAcceptedAtMs:
          recordingConsentAcceptedAtMs ?? this.recordingConsentAcceptedAtMs,
      recentlyDeletedRetentionDays: clearRecentlyDeletedRetention
          ? null
          : recentlyDeletedRetentionDays ?? this.recentlyDeletedRetentionDays,
      retentionLastSuccessfulScanAtMs:
          retentionLastSuccessfulScanAtMs ??
          this.retentionLastSuccessfulScanAtMs,
      meetingProcessingLocation:
          meetingProcessingLocation ?? this.meetingProcessingLocation,
      meetingAiProviderId: clearMeetingAiProvider
          ? null
          : meetingAiProviderId ?? this.meetingAiProviderId,
      meetingAiModelId: clearMeetingAiModel
          ? null
          : meetingAiModelId ?? this.meetingAiModelId,
      meetingAiSecretConfigured:
          meetingAiSecretConfigured ?? this.meetingAiSecretConfigured,
    );
  }

  static String? _nonEmpty(String? value) {
    final normalized = value?.trim();
    return normalized?.isEmpty == true ? null : normalized;
  }
}
