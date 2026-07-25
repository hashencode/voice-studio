import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_job_reconciler.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_port.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_queue_coordinator.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'enqueue returns before recognition and drains FIFO one at a time',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = TranscriptionJobsRepository(
        database: fixture.appDatabase,
      );
      final port = _ControlledTranscriptionPort();
      final coordinator = TranscriptionQueueCoordinator(
        repository: repository,
        transcriptionPort: port,
        settingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
        reconciler: TranscriptionJobReconciler(repository: repository),
      );
      addTearDown(coordinator.dispose);

      await coordinator.start();
      final first = await coordinator.enqueue(
        recordingPath: '/meetings/first.m4a',
        durationMs: 1000,
      );
      final second = await coordinator.enqueue(
        recordingPath: '/meetings/second.m4a',
        durationMs: 2000,
      );
      await _eventually(() => port.startedJobIds.length == 1);

      expect(first.inserted, isTrue);
      expect(second.inserted, isTrue);
      expect(port.startedJobIds, <int>[first.jobId]);
      expect(port.maxConcurrent, 1);

      port.complete(first.jobId, '第一段');
      await _eventually(() => port.startedJobIds.length == 2);
      expect(port.startedJobIds, <int>[first.jobId, second.jobId]);
      expect(port.maxConcurrent, 1);

      port.complete(second.jobId, '第二段');
      await coordinator.waitUntilIdle();
      expect((await repository.findById(first.jobId))?.status, 'completed');
      expect((await repository.findById(second.jobId))?.status, 'completed');
    },
  );

  test('processing cancellation reaches native and becomes terminal', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final port = _ControlledTranscriptionPort();
    final coordinator = TranscriptionQueueCoordinator(
      repository: repository,
      transcriptionPort: port,
      settingsRepository: AppSettingsRepository(database: fixture.appDatabase),
      reconciler: TranscriptionJobReconciler(repository: repository),
    );
    addTearDown(coordinator.dispose);

    await coordinator.start();
    final queued = await coordinator.enqueue(
      recordingPath: '/meetings/cancel.m4a',
      durationMs: 1000,
    );
    await _eventually(() => port.startedJobIds.contains(queued.jobId));

    await coordinator.cancel(queued.jobId);
    await coordinator.waitUntilIdle();

    expect(port.canceledJobIds, contains(queued.jobId));
    final canceled = await repository.findById(queued.jobId);
    expect(canceled?.status, 'canceled');
    expect(canceled?.failureStage, 'cancellation');
  });

  test('native stage failure is normalized in the persisted job', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final port = _ControlledTranscriptionPort();
    final coordinator = TranscriptionQueueCoordinator(
      repository: repository,
      transcriptionPort: port,
      settingsRepository: AppSettingsRepository(database: fixture.appDatabase),
      reconciler: TranscriptionJobReconciler(repository: repository),
    );
    addTearDown(coordinator.dispose);

    await coordinator.start();
    final queued = await coordinator.enqueue(
      recordingPath: '/meetings/model-failure.m4a',
      durationMs: 1000,
    );
    await _eventually(() => port.startedJobIds.contains(queued.jobId));
    port.fail(
      queued.jobId,
      const TranscriptionFailure(
        code: 'MODEL_NOT_READY',
        stage: 'model',
        message: '模型不可用',
      ),
    );
    await coordinator.waitUntilIdle();

    final failed = await repository.findById(queued.jobId);
    expect(failed?.status, 'failed');
    expect(failed?.failureStage, 'model');
    expect(failed?.errorCode, 'MODEL_NOT_READY');
  });

  test('each retry attempt reads the latest punctuation setting', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final settingsRepository = AppSettingsRepository(
      database: fixture.appDatabase,
    );
    await settingsRepository.save(
      AppSettings.defaults().copyWith(enablePunctuation: false),
    );
    final port = _ControlledTranscriptionPort();
    final coordinator = TranscriptionQueueCoordinator(
      repository: repository,
      transcriptionPort: port,
      settingsRepository: settingsRepository,
      reconciler: TranscriptionJobReconciler(repository: repository),
    );
    addTearDown(coordinator.dispose);

    await coordinator.start();
    final queued = await coordinator.enqueue(
      recordingPath: '/meetings/punctuation-setting.m4a',
      durationMs: 1000,
    );
    await _eventually(() => port.requests.length == 1);
    expect(port.requests.single.enablePunctuation, isFalse);
    port.fail(
      queued.jobId,
      const TranscriptionFailure(
        code: 'PUNCTUATION_FAILED',
        stage: 'punctuation',
        message: '标点失败',
      ),
    );
    await coordinator.waitUntilIdle();

    await settingsRepository.save(
      AppSettings.defaults().copyWith(enablePunctuation: true),
    );
    expect(await coordinator.retry(queued.jobId), isTrue);
    await _eventually(() => port.requests.length == 2);
    expect(port.requests.last.enablePunctuation, isTrue);
    port.complete(queued.jobId, '重试完成');
    await coordinator.waitUntilIdle();
  });

  test('all native failure stages remain distinguishable', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final port = _ControlledTranscriptionPort();
    final coordinator = TranscriptionQueueCoordinator(
      repository: repository,
      transcriptionPort: port,
      settingsRepository: AppSettingsRepository(database: fixture.appDatabase),
      reconciler: TranscriptionJobReconciler(repository: repository),
    );
    addTearDown(coordinator.dispose);
    await coordinator.start();

    for (final stage in <String>[
      'input',
      'transcode',
      'model',
      'vad',
      'decode',
      'punctuation',
    ]) {
      final queued = await coordinator.enqueue(
        recordingPath: '/meetings/$stage.m4a',
        durationMs: 1000,
      );
      await _eventually(() => port.startedJobIds.contains(queued.jobId));
      port.fail(
        queued.jobId,
        TranscriptionFailure(
          code: '${stage.toUpperCase()}_FAILED',
          stage: stage,
          message: '$stage failed',
        ),
      );
      await coordinator.waitUntilIdle();
      final failed = await repository.findById(queued.jobId);
      expect(failed?.status, 'failed');
      expect(failed?.failureStage, stage);
      expect(failed?.errorCode, '${stage.toUpperCase()}_FAILED');
    }
  });

  test('result persistence failures become retryable queue failures', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = TranscriptionJobsRepository(
      database: fixture.appDatabase,
    );
    final port = _ControlledTranscriptionPort();
    final coordinator = TranscriptionQueueCoordinator(
      repository: repository,
      transcriptionPort: port,
      settingsRepository: AppSettingsRepository(database: fixture.appDatabase),
      reconciler: TranscriptionJobReconciler(repository: repository),
      generationsRepository: _FailingGenerationsRepository(
        database: fixture.appDatabase,
      ),
    );
    addTearDown(coordinator.dispose);
    await coordinator.start();
    final queued = await coordinator.enqueue(
      recordingPath: '/meetings/persistence.m4a',
      durationMs: 1000,
    );
    await _eventually(() => port.startedJobIds.contains(queued.jobId));

    port.complete(queued.jobId, '无法保存的结果');
    await coordinator.waitUntilIdle();

    final failed = await repository.findById(queued.jobId);
    expect(failed?.status, 'failed');
    expect(failed?.failureStage, 'persistence');
    expect(failed?.errorCode, 'PERSISTENCE_FAILED');
    expect(await repository.retry(queued.jobId), isTrue);
  });

  test(
    'app restart requeues processing work missing from native runtime',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = TranscriptionJobsRepository(
        database: fixture.appDatabase,
      );
      final queued = await repository.enqueue(
        recordingPath: '/meetings/restart.m4a',
        durationMs: 1000,
      );
      await repository.claimNextPending();
      expect((await repository.findById(queued.jobId))?.status, 'processing');
      final port = _ControlledTranscriptionPort();
      final coordinator = TranscriptionQueueCoordinator(
        repository: repository,
        transcriptionPort: port,
        settingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
        reconciler: TranscriptionJobReconciler(repository: repository),
      );
      addTearDown(coordinator.dispose);

      await coordinator.start();
      await _eventually(() => port.startedJobIds.contains(queued.jobId));
      expect((await repository.findById(queued.jobId))?.attemptCount, 2);

      port.complete(queued.jobId, '恢复完成');
      await coordinator.waitUntilIdle();
      expect((await repository.findById(queued.jobId))?.status, 'completed');
    },
  );

  test(
    'app restart reattaches to a native job without incrementing its attempt',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = TranscriptionJobsRepository(
        database: fixture.appDatabase,
      );
      final queued = await repository.enqueue(
        recordingPath: '/meetings/native-resume.m4a',
        durationMs: 1000,
      );
      await repository.claimNextPending();
      final port = _ControlledTranscriptionPort()
        ..seedNativeActive(queued.jobId);
      final coordinator = TranscriptionQueueCoordinator(
        repository: repository,
        transcriptionPort: port,
        settingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
        reconciler: TranscriptionJobReconciler(repository: repository),
      );
      addTearDown(coordinator.dispose);

      await coordinator.start();
      await _eventually(() => port.startedJobIds.contains(queued.jobId));
      expect((await repository.findById(queued.jobId))?.attemptCount, 1);

      port.complete(queued.jobId, '原生恢复完成');
      await coordinator.waitUntilIdle();
      final completed = await repository.findById(queued.jobId);
      expect(completed?.status, 'completed');
      expect(completed?.resultText, '原生恢复完成');
    },
  );
}

class _ControlledTranscriptionPort implements TranscriptionPort {
  final StreamController<TranscriptionProgressEvent> _progress =
      StreamController<TranscriptionProgressEvent>.broadcast();
  final Map<int, Completer<TranscriptionResult>> _active =
      <int, Completer<TranscriptionResult>>{};
  final List<int> startedJobIds = <int>[];
  final List<TranscriptionRequest> requests = <TranscriptionRequest>[];
  final List<int> canceledJobIds = <int>[];
  int maxConcurrent = 0;

  @override
  Stream<TranscriptionProgressEvent> get progressEvents => _progress.stream;

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) {
    startedJobIds.add(jobId);
    requests.add(request);
    final completer = _active.putIfAbsent(
      jobId,
      Completer<TranscriptionResult>.new,
    );
    maxConcurrent = maxConcurrent < _active.length
        ? _active.length
        : maxConcurrent;
    _progress.add(
      TranscriptionProgressEvent(
        jobId: jobId,
        stage: 'transcode',
        progress: 0.1,
      ),
    );
    return completer.future.whenComplete(() => _active.remove(jobId));
  }

  @override
  Future<void> cancel(int jobId) async {
    canceledJobIds.add(jobId);
    _active[jobId]?.completeError(const TranscriptionCanceledException());
  }

  @override
  Future<Set<int>> activeJobIds() async => _active.keys.toSet();

  void seedNativeActive(int jobId) {
    _active[jobId] = Completer<TranscriptionResult>();
  }

  void complete(int jobId, String text) => _active[jobId]?.complete(
    TranscriptionResult.singleText(text, durationMs: 1000),
  );

  void fail(int jobId, Object error) => _active[jobId]?.completeError(error);
}

class _FailingGenerationsRepository extends TranscriptGenerationsRepository {
  _FailingGenerationsRepository({required AppDatabase database})
    : super(database: database);

  @override
  Future<TranscriptGenerationCommit> persistCompletedResult({
    required TranscriptionJobEntity job,
    required TranscriptionResult result,
  }) {
    throw StateError('simulated persistence failure');
  }
}

Future<void> _eventually(bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition was not reached');
}
