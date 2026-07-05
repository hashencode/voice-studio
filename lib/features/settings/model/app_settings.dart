enum RecordingMode {
  standard,
  realtime,
  auto;

  static RecordingMode fromStorage(String? value) {
    for (final RecordingMode mode in RecordingMode.values) {
      if (mode.name == value) {
        return mode;
      }
    }
    return RecordingMode.standard;
  }

  String get storageValue => name;

  String get label {
    switch (this) {
      case RecordingMode.standard:
        return '标准录音';
      case RecordingMode.realtime:
        return '实时转写';
      case RecordingMode.auto:
        return '自动推荐';
    }
  }

  String get description {
    switch (this) {
      case RecordingMode.standard:
        return '先稳定保存音频，停止后再离线识别。';
      case RecordingMode.realtime:
        return '边录边生成分段文本，同时保存完整音频。';
      case RecordingMode.auto:
        return '当前先保守使用标准录音，后续接入设备推荐。';
    }
  }
}

class AppSettings {
  AppSettings({
    required this.modelId,
    required this.recordingMode,
    required this.autoTranscribe,
    required this.isDarkMode,
  });

  final String modelId;
  final RecordingMode recordingMode;
  final bool autoTranscribe;
  final bool isDarkMode;

  static AppSettings defaults() {
    return AppSettings(
      modelId: 'paraformer-zh',
      recordingMode: RecordingMode.standard,
      autoTranscribe: true,
      isDarkMode: false,
    );
  }

  AppSettings copyWith({
    String? modelId,
    RecordingMode? recordingMode,
    bool? autoTranscribe,
    bool? isDarkMode,
  }) {
    return AppSettings(
      modelId: modelId ?? this.modelId,
      recordingMode: recordingMode ?? this.recordingMode,
      autoTranscribe: autoTranscribe ?? this.autoTranscribe,
      isDarkMode: isDarkMode ?? this.isDarkMode,
    );
  }
}
