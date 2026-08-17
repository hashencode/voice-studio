import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';

void main() {
  test('defaults keep automatic transcription enabled', () {
    final AppSettings settings = AppSettings.defaults();

    expect(settings.modelId, 'paraformer-zh');
    expect(settings.autoTranscribe, isTrue);
    expect(settings.enablePunctuation, isTrue);
    expect(settings.recentlyDeletedRetentionDays, isNull);
    expect(settings.retentionLastSuccessfulScanAtMs, isNull);
    expect(
      settings.meetingProcessingLocation,
      MeetingProcessingLocation.onDevice,
    );
    expect(settings.meetingAiProviderId, isNull);
    expect(settings.meetingAiModelId, isNull);
    expect(settings.meetingAiSecretConfigured, isFalse);
  });

  test('cloud AI preferences normalize and remain non-secret', () {
    final settings = AppSettings.fromStorage(
      modelId: 'paraformer-zh',
      autoTranscribe: true,
      isDarkMode: false,
      meetingProcessingLocation: 'cloudDirect',
      meetingAiProviderId: ' deepseek ',
      meetingAiModelId: ' deepseek-v4-flash ',
      meetingAiSecretConfigured: true,
    );

    expect(
      settings.meetingProcessingLocation,
      MeetingProcessingLocation.cloudDirect,
    );
    expect(settings.meetingAiProviderId, 'deepseek');
    expect(settings.meetingAiModelId, 'deepseek-v4-flash');
    expect(settings.meetingAiSecretConfigured, isTrue);

    final local = settings.copyWith(
      meetingProcessingLocation: MeetingProcessingLocation.onDevice,
      meetingAiSecretConfigured: false,
    );
    expect(local.meetingProcessingLocation, MeetingProcessingLocation.onDevice);
    expect(local.meetingAiSecretConfigured, isFalse);
  });

  test('legacy product selections normalize to the single runtime', () {
    final AppSettings settings = AppSettings.fromStorage(
      modelId: 'sherpa-streaming-zh',
      autoTranscribe: false,
      enablePunctuation: false,
      isDarkMode: true,
    );

    expect(settings.modelId, AppSettings.supportedModelId);
    expect(AppSettings.normalizeRecordingMode('live_vad'), 'standard');
    expect(settings.autoTranscribe, isFalse);
    expect(settings.enablePunctuation, isFalse);
    expect(settings.isDarkMode, isTrue);
  });

  test('copyWith preserves and updates punctuation independently', () {
    final defaults = AppSettings.defaults();

    expect(defaults.copyWith(isDarkMode: true).enablePunctuation, isTrue);
    expect(
      defaults.copyWith(enablePunctuation: false).enablePunctuation,
      isFalse,
    );
  });

  test('retention accepts only disabled, 7, 30, or 90 days', () {
    for (final days in <int?>[null, 7, 30, 90]) {
      final settings = AppSettings.fromStorage(
        modelId: 'paraformer-zh',
        autoTranscribe: true,
        isDarkMode: false,
        recentlyDeletedRetentionDays: days,
      );
      expect(settings.recentlyDeletedRetentionDays, days);
    }

    final invalid = AppSettings.fromStorage(
      modelId: 'paraformer-zh',
      autoTranscribe: true,
      isDarkMode: false,
      recentlyDeletedRetentionDays: 14,
    );
    expect(invalid.recentlyDeletedRetentionDays, isNull);
  });

  test('retention changes preserve unrelated settings', () {
    final settings = AppSettings(
      modelId: 'paraformer-zh',
      autoTranscribe: false,
      enablePunctuation: false,
      isDarkMode: true,
      recordingConsentVersion: 4,
      recordingConsentAcceptedAtMs: 123,
      recentlyDeletedRetentionDays: 30,
      retentionLastSuccessfulScanAtMs: 456,
    );

    final disabled = settings.copyWith(clearRecentlyDeletedRetention: true);

    expect(disabled.recentlyDeletedRetentionDays, isNull);
    expect(disabled.modelId, settings.modelId);
    expect(disabled.autoTranscribe, isFalse);
    expect(disabled.enablePunctuation, isFalse);
    expect(disabled.isDarkMode, isTrue);
    expect(disabled.recordingConsentVersion, 4);
    expect(disabled.recordingConsentAcceptedAtMs, 123);
    expect(disabled.retentionLastSuccessfulScanAtMs, 456);
  });
}
