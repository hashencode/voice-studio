import '../../audio_intelligence/service/audio_intelligence_provider.dart';

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
    this.audioProcessingLocation = AudioProcessingLocation.onDevice,
    this.audioAiProviderId,
    this.audioAiModelId,
    this.audioAiSecretConfigured = false,
  });

  final String modelId;
  final bool autoTranscribe;
  final bool enablePunctuation;
  final bool isDarkMode;
  final int recordingConsentVersion;
  final int? recordingConsentAcceptedAtMs;
  final int? recentlyDeletedRetentionDays;
  final int? retentionLastSuccessfulScanAtMs;
  final AudioProcessingLocation audioProcessingLocation;
  final String? audioAiProviderId;
  final String? audioAiModelId;
  final bool audioAiSecretConfigured;

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
      audioProcessingLocation: AudioProcessingLocation.onDevice,
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
    Object? audioProcessingLocation,
    String? audioAiProviderId,
    String? audioAiModelId,
    bool audioAiSecretConfigured = false,
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
      audioProcessingLocation: AudioProcessingLocation.fromStorage(
        audioProcessingLocation,
      ),
      audioAiProviderId: _nonEmpty(audioAiProviderId),
      audioAiModelId: _nonEmpty(audioAiModelId),
      audioAiSecretConfigured: audioAiSecretConfigured,
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
    AudioProcessingLocation? audioProcessingLocation,
    String? audioAiProviderId,
    bool clearAudioAiProvider = false,
    String? audioAiModelId,
    bool clearAudioAiModel = false,
    bool? audioAiSecretConfigured,
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
      audioProcessingLocation:
          audioProcessingLocation ?? this.audioProcessingLocation,
      audioAiProviderId: clearAudioAiProvider
          ? null
          : audioAiProviderId ?? this.audioAiProviderId,
      audioAiModelId: clearAudioAiModel
          ? null
          : audioAiModelId ?? this.audioAiModelId,
      audioAiSecretConfigured:
          audioAiSecretConfigured ?? this.audioAiSecretConfigured,
    );
  }

  static String? _nonEmpty(String? value) {
    final normalized = value?.trim();
    return normalized?.isEmpty == true ? null : normalized;
  }
}
