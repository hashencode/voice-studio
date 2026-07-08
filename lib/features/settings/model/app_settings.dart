class AppSettings {
  AppSettings({
    required this.modelId,
    required this.autoTranscribe,
    required this.isDarkMode,
  });

  final String modelId;
  final bool autoTranscribe;
  final bool isDarkMode;

  static AppSettings defaults() {
    return AppSettings(
      modelId: 'paraformer-zh',
      autoTranscribe: true,
      isDarkMode: false,
    );
  }

  AppSettings copyWith({
    String? modelId,
    bool? autoTranscribe,
    bool? isDarkMode,
  }) {
    return AppSettings(
      modelId: modelId ?? this.modelId,
      autoTranscribe: autoTranscribe ?? this.autoTranscribe,
      isDarkMode: isDarkMode ?? this.isDarkMode,
    );
  }
}
