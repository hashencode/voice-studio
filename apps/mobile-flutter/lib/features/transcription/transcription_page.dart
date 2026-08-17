import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../settings/repository/app_settings_repository.dart';
import '../shared/utils/formatters.dart';
import '../shared/widgets/build_info_footer.dart';
import '../shared/widgets/common_empty_state.dart';
import 'model/transcription_job_entity.dart';
import 'repository/transcription_jobs_repository.dart';
import 'service/transcription_job_reconciler.dart';
import 'service/transcription_port.dart';
import 'service/transcription_queue_coordinator.dart';

class TranscriptionPage extends StatefulWidget {
  const TranscriptionPage({
    super.key,
    this.repository,
    this.coordinator,
    this.transcriptionPort,
  });

  final TranscriptionJobsRepository? repository;
  final TranscriptionQueueCoordinator? coordinator;
  final TranscriptionPort? transcriptionPort;

  @override
  State<TranscriptionPage> createState() => _TranscriptionPageState();
}

class _TranscriptionPageState extends State<TranscriptionPage> {
  late final TranscriptionJobsRepository _repository;
  late final TranscriptionQueueCoordinator _coordinator;
  late final bool _ownsCoordinator;
  StreamSubscription<void>? _changesSubscription;

  List<TranscriptionJobEntity> _jobs = <TranscriptionJobEntity>[];
  bool _loading = true;
  final Set<int> _acting = <int>{};

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? TranscriptionJobsRepository();
    _ownsCoordinator = widget.coordinator == null;
    _coordinator =
        widget.coordinator ??
        TranscriptionQueueCoordinator(
          repository: _repository,
          transcriptionPort:
              widget.transcriptionPort ??
              (throw StateError(
                'TranscriptionPage requires an injected transcription port.',
              )),
          settingsRepository: AppSettingsRepository(),
          reconciler: TranscriptionJobReconciler(repository: _repository),
        );
    _changesSubscription = _coordinator.changes.listen((_) => _load());
    unawaited(_coordinator.start());
    unawaited(_load(showLoading: true));
  }

  @override
  void dispose() {
    unawaited(_changesSubscription?.cancel());
    if (_ownsCoordinator) {
      unawaited(_coordinator.dispose());
    }
    super.dispose();
  }

  Future<void> _load({bool showLoading = false}) async {
    if (showLoading && mounted) {
      setState(() {
        _loading = true;
      });
    }
    final jobs = await _repository.listRecent();
    if (!mounted) return;
    setState(() {
      _jobs = jobs;
      _loading = false;
    });
  }

  Future<void> _retry(int id) async {
    if (_acting.contains(id)) return;
    setState(() => _acting.add(id));
    final retried = await _coordinator.retry(id);
    if (mounted) {
      setState(() => _acting.remove(id));
      if (!retried) {
        await _showMessage('该任务当前不可重试。');
      }
    }
  }

  Future<void> _cancel(int id) async {
    if (_acting.contains(id)) return;
    setState(() => _acting.add(id));
    await _coordinator.cancel(id);
    if (mounted) {
      setState(() => _acting.remove(id));
    }
  }

  Future<void> _showMessage(String message) {
    return showGooDialog<void>(
      context: context,
      builder: (_) => GooDialog<void>.confirmation(
        title: '提示',
        description: message,
        actions: const <GooDialogAction>[
          GooDialogAction(label: '知道了', style: GooDialogActionStyle.primary),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: GooAppBar.secondary(
        title: '转写',
        actions: <GooAppBarIconAction>[
          GooAppBarIconAction(
            iconName: GooIcons.refresh,
            semanticLabel: '刷新转写任务',
            tooltip: '刷新',
            onPressed: () => _load(showLoading: true),
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: GooSpinner(
                showLabel: true,
                label: '正在加载转写任务',
                liveRegion: true,
              ),
            )
          : _jobs.isEmpty
          ? const CommonEmptyState(
              icon: Icons.text_snippet_outlined,
              title: '暂无转写任务',
              description: '录音停止或媒体导入完成后，会自动进入本地转写队列。',
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
              children: <Widget>[
                GooList.builder(
                  itemCount: _jobs.length,
                  itemBuilder: (BuildContext context, int index) {
                    final job = _jobs[index];
                    return _JobRow(
                      job: job,
                      acting: _acting.contains(job.id),
                      onRetry: () => _retry(job.id),
                      onCancel: () => _cancel(job.id),
                    );
                  },
                ),
              ],
            ),
      bottomNavigationBar: const SafeArea(top: false, child: BuildInfoFooter()),
    );
  }
}

class _JobRow extends StatelessWidget implements GooListRowChild {
  const _JobRow({
    required this.job,
    required this.acting,
    required this.onRetry,
    required this.onCancel,
    this.showDivider = true,
    this.padding,
    this.minHeight,
  });

  final TranscriptionJobEntity job;
  final bool acting;
  final VoidCallback onRetry;
  final VoidCallback onCancel;
  final bool showDivider;
  final EdgeInsetsGeometry? padding;
  final double? minHeight;

  @override
  Widget copyWithListRow({
    bool? showDivider,
    EdgeInsetsGeometry? padding,
    double? minHeight,
    GooListStyle? listStyle,
    GooListRowPosition? rowPosition,
  }) {
    return _JobRow(
      job: job,
      acting: acting,
      onRetry: onRetry,
      onCancel: onCancel,
      showDivider: showDivider ?? this.showDivider,
      padding: padding ?? this.padding,
      minHeight: minHeight ?? this.minHeight,
    );
  }

  @override
  Widget build(BuildContext context) {
    final processing = job.status == 'processing';
    final canCancel = job.status == 'pending' || processing;
    final canRetry = job.status == 'failed' || job.status == 'canceled';
    final progress = (job.progress ?? 0).clamp(0.0, 1.0);
    return Container(
      constraints: BoxConstraints(minHeight: minHeight ?? 88),
      padding:
          padding ?? const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        border: showDivider
            ? Border(
                bottom: BorderSide(
                  color: Theme.of(context).dividerColor,
                  width: 0.5,
                ),
              )
            : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              GooIcon(
                id: _statusIcon(job.status),
                size: 22,
                semanticLabel: _statusLabel(job.status),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '任务 #${job.id} · ${_statusLabel(job.status)}',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _subtitle(job),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              if (canCancel)
                GooActionIcon(
                  iconName: GooIcons.close,
                  semanticLabel: '取消任务 #${job.id}',
                  onPressed: acting ? null : onCancel,
                )
              else if (canRetry)
                GooActionIcon(
                  iconName: GooIcons.refresh,
                  semanticLabel: '重试任务 #${job.id}',
                  onPressed: acting ? null : onRetry,
                ),
            ],
          ),
          if (processing) ...<Widget>[
            const SizedBox(height: 10),
            GooProgress(
              value: progress,
              semanticLabel: '任务 #${job.id} 转写进度',
              liveRegion: true,
            ),
          ],
        ],
      ),
    );
  }
}

String _statusLabel(String status) {
  return switch (status) {
    'pending' => '待处理',
    'processing' => '处理中',
    'completed' => '已完成',
    'failed' => '失败',
    'canceled' => '已取消',
    _ => status,
  };
}

GooIconId _statusIcon(String status) {
  return switch (status) {
    'pending' => GooIcons.time,
    'processing' => GooIcons.refresh,
    'completed' => GooIcons.text,
    'failed' || 'canceled' => GooIcons.close,
    _ => GooIcons.audioFiles,
  };
}

String _subtitle(TranscriptionJobEntity job) {
  final stage = _stageLabel(job.failureStage ?? job.stage);
  final percent = (((job.progress ?? 0).clamp(0.0, 1.0)) * 100).round();
  final detail = job.resultText ?? job.errorMessage;
  final summary = detail == null || detail.isEmpty ? '' : '\n$detail';
  return '$stage · $percent% · 第 ${job.attemptCount} 次尝试 · '
      '${formatDurationMs(job.durationMs)}$summary';
}

String _stageLabel(String stage) {
  return switch (stage) {
    'queued' => '等待调度',
    'input' => '输入校验',
    'transcode' => '音频转码',
    'model' => '模型准备',
    'vad' => '语音检测',
    'decode' => '文本解码',
    'persistence' => '结果保存',
    'completed' => '处理完成',
    'cancellation' || 'canceled' => '任务取消',
    'failed' => '处理失败',
    _ => '处理阶段未知',
  };
}
