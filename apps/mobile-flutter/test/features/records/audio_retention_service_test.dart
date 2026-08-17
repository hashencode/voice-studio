import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/records/service/audio_deletion_coordinator.dart';
import 'package:voice2text_flutter/features/records/service/audio_retention_service.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  final now = DateTime.utc(2026, 7, 24, 12);

  test('default disabled policy never deletes recently deleted data', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = RecordingsRepository(database: fixture.appDatabase);
    final id = await _insertRecording(
      repository,
      fingerprint: 'disabled',
      deletedAtMs: now
          .subtract(const Duration(days: 365))
          .millisecondsSinceEpoch,
      database: fixture.database,
    );
    final service = _service(
      fixture: fixture,
      repository: repository,
      now: now,
    );

    final result = await service.scan();

    expect(result.status, AudioRetentionScanStatus.disabled);
    expect(result.examinedCount, 0);
    expect(await repository.findById(id), isNotNull);
  });

  test('saving retention preserves all unrelated app settings', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final settingsRepository = AppSettingsRepository(
      database: fixture.appDatabase,
    );
    await settingsRepository.save(
      AppSettings(
        modelId: AppSettings.supportedModelId,
        autoTranscribe: false,
        enablePunctuation: false,
        isDarkMode: true,
        recordingConsentVersion: 3,
        recordingConsentAcceptedAtMs: 1234,
      ),
    );

    await settingsRepository.saveRecentlyDeletedRetentionDays(30);
    final saved = await settingsRepository.load();

    expect(saved.recentlyDeletedRetentionDays, 30);
    expect(saved.modelId, AppSettings.supportedModelId);
    expect(saved.autoTranscribe, isFalse);
    expect(saved.enablePunctuation, isFalse);
    expect(saved.isDarkMode, isTrue);
    expect(saved.recordingConsentVersion, 3);
    expect(saved.recordingConsentAcceptedAtMs, 1234);
  });

  for (final retentionDays in AppSettings.supportedRetentionDays) {
    test(
      '$retentionDays-day boundary expires at the exact millisecond only',
      () async {
        final fixture = await openRecordingTestDatabase();
        addTearDown(fixture.database.close);
        final repository = RecordingsRepository(database: fixture.appDatabase);
        final cutoff = now
            .subtract(Duration(days: retentionDays))
            .millisecondsSinceEpoch;
        final expiredId = await _insertRecording(
          repository,
          fingerprint: 'expired-$retentionDays',
          deletedAtMs: cutoff,
          database: fixture.database,
        );
        final notExpiredId = await _insertRecording(
          repository,
          fingerprint: 'fresh-$retentionDays',
          deletedAtMs: cutoff + 1,
          database: fixture.database,
        );
        final activeId = await _insertRecording(
          repository,
          fingerprint: 'active-$retentionDays',
          database: fixture.database,
        );
        final settingsRepository = AppSettingsRepository(
          database: fixture.appDatabase,
        );
        await settingsRepository.saveRecentlyDeletedRetentionDays(
          retentionDays,
        );
        final service = _service(
          fixture: fixture,
          repository: repository,
          settingsRepository: settingsRepository,
          now: now,
        );

        final result = await service.scan();

        expect(result.status, AudioRetentionScanStatus.completed);
        expect(result.deletedCount, 1);
        expect(await repository.findById(expiredId), isNull);
        expect(await repository.findById(notExpiredId), isNotNull);
        expect(await repository.findById(activeId), isNotNull);
        expect(
          (await settingsRepository.load()).retentionLastSuccessfulScanAtMs,
          now.millisecondsSinceEpoch,
        );
      },
    );
  }

  test('file failure stays pending and the next scan retries it', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = RecordingsRepository(database: fixture.appDatabase);
    final deletedAtMs = now
        .subtract(const Duration(days: 8))
        .millisecondsSinceEpoch;
    final id = await _insertRecording(
      repository,
      fingerprint: 'retry',
      deletedAtMs: deletedAtMs,
      database: fixture.database,
    );
    final settingsRepository = AppSettingsRepository(
      database: fixture.appDatabase,
    );
    await settingsRepository.saveRecentlyDeletedRetentionDays(7);
    final fileStore = _RetryFileStore();
    final service = _service(
      fixture: fixture,
      repository: repository,
      settingsRepository: settingsRepository,
      now: now,
      fileStore: fileStore,
    );

    final first = await service.scan();

    expect(first.status, AudioRetentionScanStatus.partial);
    expect(first.failedCount, 1);
    final pending = await repository.findById(id);
    expect(pending?.deletionState, 'pending');
    expect(pending?.deletedAtMs, deletedAtMs);
    expect(
      (await settingsRepository.load()).retentionLastSuccessfulScanAtMs,
      isNull,
    );

    fileStore.allowDeletion = true;
    final second = await service.scan();

    expect(second.status, AudioRetentionScanStatus.completed);
    expect(second.deletedCount, 1);
    expect(await repository.findById(id), isNull);
  });

  test(
    'large result sets are processed in bounded resumable batches',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = RecordingsRepository(database: fixture.appDatabase);
      for (var index = 0; index < 3; index += 1) {
        await _insertRecording(
          repository,
          fingerprint: 'batch-$index',
          deletedAtMs: now
              .subtract(Duration(days: 10 + index))
              .millisecondsSinceEpoch,
          database: fixture.database,
        );
      }
      final settingsRepository = AppSettingsRepository(
        database: fixture.appDatabase,
      );
      await settingsRepository.saveRecentlyDeletedRetentionDays(7);
      final service = _service(
        fixture: fixture,
        repository: repository,
        settingsRepository: settingsRepository,
        now: now,
        batchSize: 2,
      );

      final first = await service.scan();

      expect(first.examinedCount, 2);
      expect(first.deletedCount, 2);
      expect(first.hasMore, isTrue);
      expect(await repository.listDeleted(), hasLength(1));
      expect(
        (await settingsRepository.load()).retentionLastSuccessfulScanAtMs,
        isNull,
      );

      final second = await service.scan();

      expect(second.examinedCount, 1);
      expect(second.deletedCount, 1);
      expect(second.hasMore, isFalse);
      expect(await repository.listDeleted(), isEmpty);
    },
  );
}

AudioRetentionService _service({
  required dynamic fixture,
  required RecordingsRepository repository,
  required DateTime now,
  AppSettingsRepository? settingsRepository,
  AudioFileStore? fileStore,
  int batchSize = 25,
}) {
  final resolvedSettings =
      settingsRepository ??
      AppSettingsRepository(database: fixture.appDatabase);
  return AudioRetentionService(
    settingsRepository: resolvedSettings,
    recordingsRepository: repository,
    deletionCoordinator: AudioDeletionCoordinator(
      recordingsRepository: repository,
      fileStore: fileStore ?? _AllowFileStore(),
    ),
    clock: () => now,
    batchSize: batchSize,
  );
}

Future<int> _insertRecording(
  RecordingsRepository repository, {
  required String fingerprint,
  required dynamic database,
  int? deletedAtMs,
}) async {
  final commit = await repository.insertImported(
    filePath: '/data/user/0/app/files/audios/imports/$fingerprint/audio.m4a',
    displayName: '$fingerprint.m4a',
    fingerprintSha256: fingerprint,
    durationMs: 1000,
  );
  if (deletedAtMs != null) {
    await database.update(
      'recordings',
      <String, Object?>{'deleted_at_ms': deletedAtMs},
      where: 'id = ?',
      whereArgs: <Object>[commit.recordingId],
    );
  }
  return commit.recordingId;
}

class _AllowFileStore implements AudioFileStore {
  @override
  Future<bool> deleteIfPresent(String path) async => true;
}

class _RetryFileStore implements AudioFileStore {
  bool allowDeletion = false;

  @override
  Future<bool> deleteIfPresent(String path) async => allowDeletion;
}
