import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_job_reconciler.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_port.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_queue_coordinator.dart';
import 'package:voice2text_flutter/features/transcription/transcription_page.dart';

void main() {
  testWidgets('failed job exposes its stage and can be retried', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository =
        _MemoryTranscriptionJobsRepository(<TranscriptionJobEntity>[
          _job(
            id: 7,
            status: 'failed',
            stage: 'failed',
            failureStage: 'model',
            progress: 0,
            attemptCount: 1,
            errorMessage: '模型不可用',
          ),
        ]);
    final coordinator = _PageCoordinator(repository);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: TranscriptionPage(
          repository: repository,
          coordinator: coordinator,
        ),
      ),
    );
    await _pumpUntil(
      tester,
      () async => find.textContaining('任务 #7 · 失败').evaluate().isNotEmpty,
    );

    expect(find.textContaining('模型准备 · 0% · 第 1 次尝试'), findsOneWidget);
    expect(find.textContaining('模型不可用'), findsOneWidget);

    await tester.tap(
      find.byWidgetPredicate(
        (widget) =>
            widget is GooActionIcon && widget.semanticLabel == '重试任务 #7',
      ),
    );
    await _pumpUntil(
      tester,
      () async => find.textContaining('任务 #7 · 已完成').evaluate().isNotEmpty,
    );

    expect(coordinator.startedJobIds, <int>[7]);
    expect(find.textContaining('重试成功'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await coordinator.dispose();
  });

  testWidgets('processing job shows progress and can be canceled', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = _MemoryTranscriptionJobsRepository(
      <TranscriptionJobEntity>[
        _job(
          id: 9,
          status: 'processing',
          stage: 'transcode',
          progress: 0.1,
          attemptCount: 1,
        ),
      ],
    );
    final coordinator = _PageCoordinator(repository);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: TranscriptionPage(
          repository: repository,
          coordinator: coordinator,
        ),
      ),
    );
    await _pumpUntil(
      tester,
      () async => find.textContaining('任务 #9 · 处理中').evaluate().isNotEmpty,
    );

    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is GooProgress && widget.semanticLabel == '任务 #9 转写进度',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('音频转码 · 10%'), findsOneWidget);

    await tester.tap(
      find.byWidgetPredicate(
        (widget) =>
            widget is GooActionIcon && widget.semanticLabel == '取消任务 #9',
      ),
    );
    await _pumpUntil(
      tester,
      () async => find.textContaining('任务 #9 · 已取消').evaluate().isNotEmpty,
    );

    expect(coordinator.canceledJobIds, <int>[9]);
    expect(find.textContaining('任务取消'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await coordinator.dispose();
  });
}

class _MemoryTranscriptionJobsRepository extends TranscriptionJobsRepository {
  _MemoryTranscriptionJobsRepository(this.jobs);

  final List<TranscriptionJobEntity> jobs;

  @override
  Future<List<TranscriptionJobEntity>> listRecent() async =>
      List<TranscriptionJobEntity>.unmodifiable(jobs);

  void replace(TranscriptionJobEntity job) {
    final index = jobs.indexWhere((candidate) => candidate.id == job.id);
    jobs[index] = job;
  }
}

class _PageCoordinator extends TranscriptionQueueCoordinator {
  _PageCoordinator(this.repository)
    : super(
        repository: repository,
        transcriptionPort: _NoopTranscriptionPort(),
        settingsRepository: AppSettingsRepository(),
        reconciler: TranscriptionJobReconciler(repository: repository),
      );

  final _MemoryTranscriptionJobsRepository repository;
  final StreamController<void> _pageChanges =
      StreamController<void>.broadcast();
  final List<int> startedJobIds = <int>[];
  final List<int> canceledJobIds = <int>[];

  @override
  Stream<void> get changes => _pageChanges.stream;

  @override
  Future<void> start() async {}

  @override
  Future<bool> retry(int jobId) async {
    final current = repository.jobs.singleWhere((job) => job.id == jobId);
    startedJobIds.add(jobId);
    repository.replace(
      _copyJob(
        current,
        status: 'completed',
        stage: 'completed',
        progress: 1,
        attemptCount: current.attemptCount + 1,
        resultText: '重试成功',
      ),
    );
    _pageChanges.add(null);
    return true;
  }

  @override
  Future<void> cancel(int jobId) async {
    final current = repository.jobs.singleWhere((job) => job.id == jobId);
    canceledJobIds.add(jobId);
    repository.replace(
      _copyJob(
        current,
        status: 'canceled',
        stage: 'canceled',
        failureStage: 'cancellation',
        progress: current.progress ?? 0,
        errorMessage: '任务已取消',
      ),
    );
    _pageChanges.add(null);
  }

  @override
  Future<void> dispose() => _pageChanges.close();
}

class _NoopTranscriptionPort implements TranscriptionPort {
  @override
  Stream<TranscriptionProgressEvent> get progressEvents =>
      const Stream<TranscriptionProgressEvent>.empty();

  @override
  Future<Set<int>> activeJobIds() async => const <int>{};

  @override
  Future<void> cancel(int jobId) async {}

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) async {
    return TranscriptionResult.singleText(
      '测试结果',
      durationMs: request.durationMs,
    );
  }
}

TranscriptionJobEntity _job({
  required int id,
  required String status,
  required String stage,
  required double progress,
  required int attemptCount,
  String? failureStage,
  String? resultText,
  String? errorMessage,
}) {
  return TranscriptionJobEntity(
    id: id,
    recordingPath: '/meetings/$id.m4a',
    recordingId: id,
    generationId: null,
    durationMs: id == 7 ? 65_000 : 120_000,
    status: status,
    recordingMode: 'standard',
    source: 'standard_offline',
    failureStage: failureStage,
    stage: stage,
    progress: progress,
    attemptCount: attemptCount,
    cancelRequested: false,
    errorCode: failureStage == null ? null : 'TEST_FAILURE',
    startedAtMs: 100,
    completedAtMs: null,
    heartbeatAtMs: 100,
    createdAtMs: 100,
    updatedAtMs: 100,
    resultText: resultText,
    errorMessage: errorMessage,
  );
}

TranscriptionJobEntity _copyJob(
  TranscriptionJobEntity current, {
  required String status,
  required String stage,
  String? failureStage,
  required double progress,
  int? attemptCount,
  String? resultText,
  String? errorMessage,
}) {
  return TranscriptionJobEntity(
    id: current.id,
    recordingPath: current.recordingPath,
    recordingId: current.recordingId,
    generationId: current.generationId,
    durationMs: current.durationMs,
    status: status,
    recordingMode: current.recordingMode,
    source: current.source,
    failureStage: failureStage,
    stage: stage,
    progress: progress,
    attemptCount: attemptCount ?? current.attemptCount,
    cancelRequested: status == 'canceled',
    errorCode: failureStage == null ? null : 'CANCELED',
    startedAtMs: current.startedAtMs,
    completedAtMs: status == 'processing' ? null : 200,
    heartbeatAtMs: 200,
    createdAtMs: current.createdAtMs,
    updatedAtMs: 200,
    resultText: resultText,
    errorMessage: errorMessage,
  );
}

Future<void> _pumpUntil(
  WidgetTester tester,
  Future<bool> Function() predicate,
) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    await tester.pump(const Duration(milliseconds: 10));
    if (await predicate()) {
      await tester.pump();
      return;
    }
  }
  fail('condition was not reached');
}
