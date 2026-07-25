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
  });

  final String modelId;
  final bool autoTranscribe;
  final bool enablePunctuation;
  final bool isDarkMode;
  final int recordingConsentVersion;
  final int? recordingConsentAcceptedAtMs;
  final int? recentlyDeletedRetentionDays;
  final int? retentionLastSuccessfulScanAtMs;

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
    );
  }
}
