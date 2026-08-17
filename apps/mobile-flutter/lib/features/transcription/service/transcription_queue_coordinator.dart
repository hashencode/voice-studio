import 'dart:async';

import '../../settings/repository/app_settings_repository.dart';
import '../model/transcription_job_entity.dart';
import '../repository/transcript_generations_repository.dart';
import '../repository/transcription_jobs_repository.dart';
import 'transcription_job_reconciler.dart';
import 'transcription_port.dart';

class TranscriptionQueueCoordinator {
  TranscriptionQueueCoordinator({
    required TranscriptionJobsRepository repository,
    required TranscriptionPort transcriptionPort,
    required AppSettingsRepository settingsRepository,
    required TranscriptionJobReconciler reconciler,
    TranscriptGenerationsRepository? generationsRepository,
  }) : _repository = repository,
       _transcriptionPort = transcriptionPort,
       _settingsRepository = settingsRepository,
       _reconciler = reconciler,
       _generationsRepository =
           generationsRepository ??
           TranscriptGenerationsRepository(database: repository.database);

  final TranscriptionJobsRepository _repository;
  final TranscriptionPort _transcriptionPort;
  final AppSettingsRepository _settingsRepository;
  final TranscriptionJobReconciler _reconciler;
  final TranscriptGenerationsRepository _generationsRepository;
  final StreamController<void> _changes = StreamController<void>.broadcast();

  Future<void>? _drainFuture;
  bool _started = false;
  bool _disposed = false;
  int? _activeJobId;

  Stream<void> get changes => _changes.stream;
  int? get activeJobId => _activeJobId;

  Future<void> start() async {
    if (_started || _disposed) return;
    _started = true;
    Set<int> activeNativeJobIds;
    try {
      activeNativeJobIds = await _transcriptionPort.activeJobIds();
    } catch (_) {
      activeNativeJobIds = const <int>{};
    }
    await _reconciler.reconcileInterrupted(
      activeNativeJobIds: activeNativeJobIds,
    );
    final resumableJobs = await _repository.listProcessing(
      jobIds: activeNativeJobIds,
    );
    _notifyChanged();
    _scheduleDrain(resumableJobs: resumableJobs);
  }

  Future<TranscriptionEnqueueResult> enqueue({
    required String recordingPath,
    required int durationMs,
    String recordingMode = 'standard',
    String source = 'standard_offline',
  }) async {
    final result = await _repository.enqueue(
      recordingPath: recordingPath,
      durationMs: durationMs,
      recordingMode: recordingMode,
      source: source,
    );
    _notifyChanged();
    kick();
    return result;
  }

  void kick() {
    _scheduleDrain();
  }

  void _scheduleDrain({
    List<TranscriptionJobEntity> resumableJobs =
        const <TranscriptionJobEntity>[],
  }) {
    if (_disposed || _drainFuture != null) return;
    final future = _drain(resumableJobs: resumableJobs);
    _drainFuture = future;
    unawaited(_finishDrain(future));
  }

  Future<void> _finishDrain(Future<void> future) async {
    try {
      await future;
    } catch (_) {
      // Queue state remains persisted and can be resumed by the next kick.
    } finally {
      try {
        if (identical(_drainFuture, future)) {
          _drainFuture = null;
        }
        if (!_disposed && await _repository.hasPending()) {
          kick();
        }
      } catch (_) {
        // A later app lifecycle event or explicit enqueue will retry the drain.
      }
    }
  }

  Future<void> cancel(int jobId) async {
    final result = await _repository.requestCancellation(jobId);
    if (result.wasProcessing) {
      try {
        await _transcriptionPort.cancel(jobId);
      } catch (_) {
        // Native cancellation is best effort; the persisted intent remains.
      }
    }
    _notifyChanged();
  }

  Future<bool> retry(int jobId) async {
    final retried = await _repository.retry(jobId);
    if (retried) {
      _notifyChanged();
      kick();
    }
    return retried;
  }

  Future<Map<int, TranscriptionRecordingRetryResult>> retryRecordings(
    Iterable<int> recordingIds,
  ) async {
    final results = await _repository.retryLatestForRecordingIds(recordingIds);
    if (results.values.any(
      (result) => result.status == TranscriptionRecordingRetryStatus.retried,
    )) {
      _notifyChanged();
      kick();
    }
    return results;
  }

  Future<void> waitUntilIdle() async {
    while (true) {
      final current = _drainFuture;
      if (current != null) {
        await current;
        continue;
      }
      if (!await _repository.hasPending()) return;
      kick();
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    final active = _activeJobId;
    if (active != null) {
      try {
        await _transcriptionPort.cancel(active);
      } catch (_) {}
    }
    await _changes.close();
  }

  Future<void> _drain({
    List<TranscriptionJobEntity> resumableJobs =
        const <TranscriptionJobEntity>[],
  }) async {
    for (final job in resumableJobs) {
      if (_disposed) return;
      _activeJobId = job.id;
      _notifyChanged();
      await _run(job);
      _activeJobId = null;
      _notifyChanged();
    }
    while (!_disposed) {
      final job = await _repository.claimNextPending();
      if (job == null) return;
      _activeJobId = job.id;
      _notifyChanged();
      await _run(job);
      _activeJobId = null;
      _notifyChanged();
    }
  }

  Future<void> _run(TranscriptionJobEntity job) async {
    var progressWrites = Future<void>.value();
    final subscription = _transcriptionPort.progressEvents
        .where((event) => event.jobId == job.id)
        .listen((event) {
          progressWrites = progressWrites.then(
            (_) => _repository.updateProgress(
              id: job.id,
              stage: event.stage,
              progress: event.progress,
            ),
          );
          unawaited(progressWrites.then((_) => _notifyChanged()));
        });
    try {
      final settings = await _settingsRepository.load();
      final result = await _transcriptionPort.transcribe(
        TranscriptionRequest(
          recordingPath: job.recordingPath,
          durationMs: job.durationMs,
          modelId: settings.modelId,
          sampleRateHz: 16000,
          enablePunctuation: settings.enablePunctuation,
          enableDenoise: false,
          attemptCount: job.attemptCount,
        ),
        jobId: job.id,
      );
      await progressWrites;
      if (await _repository.isCancellationRequested(job.id)) {
        await _repository.markCanceled(job.id);
      } else {
        try {
          await _repository.updateProgress(
            id: job.id,
            stage: 'persistence',
            progress: 0.98,
          );
          await _generationsRepository.persistCompletedResult(
            job: job,
            result: result,
          );
        } catch (_) {
          await _repository.fail(
            id: job.id,
            stage: 'persistence',
            code: 'PERSISTENCE_FAILED',
            message: '转写结果保存失败',
          );
        }
      }
    } on TranscriptionCanceledException {
      await _repository.markCanceled(job.id);
    } on TranscriptionFailure catch (error) {
      if (await _repository.isCancellationRequested(job.id)) {
        await _repository.markCanceled(job.id);
      } else {
        await _repository.fail(
          id: job.id,
          stage: error.stage,
          code: error.code,
          message: error.message,
        );
      }
    } catch (error) {
      if (await _repository.isCancellationRequested(job.id)) {
        await _repository.markCanceled(job.id);
      } else {
        await _repository.fail(
          id: job.id,
          stage: 'unknown',
          code: 'TRANSCRIPTION_UNKNOWN',
          message: '转写失败：${error.runtimeType}',
        );
      }
    } finally {
      await subscription.cancel();
      await progressWrites;
    }
  }

  void _notifyChanged() {
    if (!_disposed && !_changes.isClosed) {
      _changes.add(null);
    }
  }
}
