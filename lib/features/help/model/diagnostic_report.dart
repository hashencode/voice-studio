import 'dart:convert';

class DiagnosticBuildInfo {
  const DiagnosticBuildInfo({
    required this.packageName,
    required this.versionName,
  });

  final String packageName;
  final String versionName;

  Map<String, Object?> toJson() => <String, Object?>{
    'packageName': packageName,
    'versionName': versionName,
  };
}

class DiagnosticDeviceProtection {
  const DiagnosticDeviceProtection({
    required this.storageScope,
    required this.protectionCategory,
    required this.protectionSummary,
    required this.applicationLayerEncryption,
    required this.platformEncryptionStatus,
    required this.backupPolicy,
  });

  final String storageScope;
  final String protectionCategory;
  final String protectionSummary;
  final bool applicationLayerEncryption;
  final String platformEncryptionStatus;
  final String backupPolicy;

  Map<String, Object?> toJson() => <String, Object?>{
    'storageScope': storageScope,
    'protectionCategory': protectionCategory,
    'protectionSummary': protectionSummary,
    'applicationLayerEncryption': applicationLayerEncryption,
    'platformEncryptionStatus': platformEncryptionStatus,
    'backupPolicy': backupPolicy,
  };
}

class DiagnosticTranscriptionSummary {
  const DiagnosticTranscriptionSummary({
    required this.statusCounts,
    required this.stageCounts,
    required this.errorCategoryCounts,
    required this.timedJobCount,
    required this.averageProcessingMs,
    required this.maximumProcessingMs,
  });

  final Map<String, int> statusCounts;
  final Map<String, int> stageCounts;
  final Map<String, int> errorCategoryCounts;
  final int timedJobCount;
  final int averageProcessingMs;
  final int maximumProcessingMs;

  Map<String, Object?> toJson() => <String, Object?>{
    'statusCounts': statusCounts,
    'stageCounts': stageCounts,
    'errorCategoryCounts': errorCategoryCounts,
    'timing': <String, Object?>{
      'jobCount': timedJobCount,
      'averageProcessingMs': averageProcessingMs,
      'maximumProcessingMs': maximumProcessingMs,
    },
  };
}

class DiagnosticReport {
  const DiagnosticReport({
    required this.generatedAtMs,
    required this.build,
    required this.deviceProtection,
    required this.transcription,
  });

  static const int schemaVersion = 1;

  final int generatedAtMs;
  final DiagnosticBuildInfo build;
  final DiagnosticDeviceProtection deviceProtection;
  final DiagnosticTranscriptionSummary transcription;

  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': schemaVersion,
    'generatedAtMs': generatedAtMs,
    'build': build.toJson(),
    'deviceProtection': deviceProtection.toJson(),
    'transcription': transcription.toJson(),
    'privacy': const <String, Object?>{
      'meetingContentIncluded': false,
      'meetingTitlesIncluded': false,
      'privatePathsIncluded': false,
      'contentUrisIncluded': false,
      'stableDeviceIdentifiersIncluded': false,
      'rawLogsIncluded': false,
    },
  };

  String toPrettyJson() => const JsonEncoder.withIndent('  ').convert(toJson());
}
