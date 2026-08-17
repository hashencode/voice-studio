import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/app_settings.dart';

class AppSettingsRepository {
  AppSettingsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<AppSettings> load() async {
    final db = await _database.database;
    final rows = await db.query('app_settings', limit: 1);

    if (rows.isEmpty) {
      final defaults = AppSettings.defaults();
      await save(defaults);
      return defaults;
    }

    final row = rows.first;
    final settings = AppSettings.fromStorage(
      modelId: row['model_id'] as String?,
      autoTranscribe: (row['auto_transcribe'] as int) == 1,
      enablePunctuation: (row['enable_punctuation'] as int? ?? 1) == 1,
      isDarkMode: (row['is_dark_mode'] as int? ?? 0) == 1,
      recordingConsentVersion: row['recording_consent_version'] as int? ?? 0,
      recordingConsentAcceptedAtMs:
          row['recording_consent_accepted_at_ms'] as int?,
      recentlyDeletedRetentionDays:
          row['recently_deleted_retention_days'] as int?,
      retentionLastSuccessfulScanAtMs:
          row['retention_last_successful_scan_at_ms'] as int?,
      meetingProcessingLocation: row['meeting_processing_location'],
      meetingAiProviderId: row['meeting_ai_provider_id'] as String?,
      meetingAiModelId: row['meeting_ai_model_id'] as String?,
      meetingAiSecretConfigured:
          (row['meeting_ai_secret_configured'] as int? ?? 0) == 1,
    );
    final normalizedRecordingMode = AppSettings.normalizeRecordingMode(
      row['recording_mode'] as String?,
    );
    if (row['model_id'] != settings.modelId ||
        row['recording_mode'] != normalizedRecordingMode) {
      await save(settings);
    }
    return settings;
  }

  Future<void> save(AppSettings settings) async {
    final db = await _database.database;
    await db.insert('app_settings', {
      'id': 1,
      'model_id': settings.modelId,
      'recording_mode': AppSettings.supportedRecordingMode,
      'auto_transcribe': settings.autoTranscribe ? 1 : 0,
      'enable_punctuation': settings.enablePunctuation ? 1 : 0,
      'is_dark_mode': settings.isDarkMode ? 1 : 0,
      'recording_consent_version': settings.recordingConsentVersion,
      'recording_consent_accepted_at_ms': settings.recordingConsentAcceptedAtMs,
      'recently_deleted_retention_days': settings.recentlyDeletedRetentionDays,
      'retention_last_successful_scan_at_ms':
          settings.retentionLastSuccessfulScanAtMs,
      'meeting_processing_location': settings.meetingProcessingLocation.name,
      'meeting_ai_provider_id': settings.meetingAiProviderId,
      'meeting_ai_model_id': settings.meetingAiModelId,
      'meeting_ai_secret_configured': settings.meetingAiSecretConfigured
          ? 1
          : 0,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<bool> hasCurrentRecordingConsent(int requiredVersion) async {
    final settings = await load();
    return settings.recordingConsentVersion >= requiredVersion &&
        settings.recordingConsentAcceptedAtMs != null;
  }

  Future<void> acceptRecordingConsent(int version) async {
    final current = await load();
    await save(
      current.copyWith(
        recordingConsentVersion: version,
        recordingConsentAcceptedAtMs: DateTime.now().millisecondsSinceEpoch,
      ),
    );
  }

  Future<void> saveRecentlyDeletedRetentionDays(int? days) async {
    if (days != null && !AppSettings.supportedRetentionDays.contains(days)) {
      throw ArgumentError.value(days, 'days', 'must be null, 7, 30, or 90');
    }
    final current = await load();
    await save(
      current.copyWith(
        recentlyDeletedRetentionDays: days,
        clearRecentlyDeletedRetention: days == null,
      ),
    );
  }

  Future<void> markRetentionScanSuccessful(int completedAtMs) async {
    final current = await load();
    await save(
      current.copyWith(retentionLastSuccessfulScanAtMs: completedAtMs),
    );
  }
}
