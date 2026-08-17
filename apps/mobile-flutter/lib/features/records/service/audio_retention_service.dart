import '../../settings/repository/app_settings_repository.dart';
import '../repository/recordings_repository.dart';
import 'audio_deletion_coordinator.dart';

typedef RetentionClock = DateTime Function();

enum AudioRetentionScanStatus { disabled, completed, partial }

class AudioRetentionScanResult {
  const AudioRetentionScanResult({
    required this.status,
    required this.policyDays,
    required this.examinedCount,
    required this.deletedCount,
    required this.failedCount,
    required this.hasMore,
  });

  final AudioRetentionScanStatus status;
  final int? policyDays;
  final int examinedCount;
  final int deletedCount;
  final int failedCount;
  final bool hasMore;
}

class AudioRetentionService {
  AudioRetentionService({
    AppSettingsRepository? settingsRepository,
    RecordingsRepository? recordingsRepository,
    AudioDeletionCoordinator? deletionCoordinator,
    RetentionClock? clock,
    this.batchSize = 25,
  }) : assert(batchSize > 0),
       _settingsRepository = settingsRepository ?? AppSettingsRepository(),
       _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _deletionCoordinator = deletionCoordinator ?? AudioDeletionCoordinator(),
       _clock = clock ?? DateTime.now;

  final AppSettingsRepository _settingsRepository;
  final RecordingsRepository _recordingsRepository;
  final AudioDeletionCoordinator _deletionCoordinator;
  final RetentionClock _clock;
  final int batchSize;

  Future<AudioRetentionScanResult>? _activeScan;

  Future<AudioRetentionScanResult> scan() {
    return _activeScan ??= _scanOnce().whenComplete(() {
      _activeScan = null;
    });
  }

  Future<AudioRetentionScanResult> _scanOnce() async {
    final settings = await _settingsRepository.load();
    final policyDays = settings.recentlyDeletedRetentionDays;
    if (policyDays == null) {
      return const AudioRetentionScanResult(
        status: AudioRetentionScanStatus.disabled,
        policyDays: null,
        examinedCount: 0,
        deletedCount: 0,
        failedCount: 0,
        hasMore: false,
      );
    }

    final nowMs = _clock().millisecondsSinceEpoch;
    final cutoffMs = nowMs - Duration(days: policyDays).inMilliseconds;
    final candidates = await _recordingsRepository.listDeletedAtOrBefore(
      deletedAtOrBeforeMs: cutoffMs,
      limit: batchSize + 1,
    );
    final hasAnotherBatch = candidates.length > batchSize;
    final currentBatch = hasAnotherBatch
        ? candidates.take(batchSize)
        : candidates;

    var deletedCount = 0;
    var failedCount = 0;
    for (final recording in currentBatch) {
      final result = await _deletionCoordinator.permanentlyDelete(recording.id);
      if (result.completed) {
        deletedCount += 1;
      } else {
        failedCount += 1;
      }
    }

    final hasMore = hasAnotherBatch || failedCount > 0;
    if (!hasMore) {
      await _settingsRepository.markRetentionScanSuccessful(nowMs);
    }
    return AudioRetentionScanResult(
      status: hasMore
          ? AudioRetentionScanStatus.partial
          : AudioRetentionScanStatus.completed,
      policyDays: policyDays,
      examinedCount: currentBatch.length,
      deletedCount: deletedCount,
      failedCount: failedCount,
      hasMore: hasMore,
    );
  }
}
