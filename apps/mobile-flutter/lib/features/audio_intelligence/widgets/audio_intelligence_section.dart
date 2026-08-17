import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../model/evidence_link_entity.dart';
import '../model/audio_insight_entity.dart';
import '../model/audio_intelligence_job_entity.dart';
import '../repository/audio_intelligence_jobs_repository.dart';
import '../repository/audio_intelligence_repository.dart';
import '../service/audio_intelligence_review_service.dart';
import 'evidence_review_panel.dart';
import 'audio_note_editor.dart';
import 'audio_topic_timeline.dart';

class AudioIntelligenceSection extends StatefulWidget {
  const AudioIntelligenceSection({
    super.key,
    required this.recordingId,
    required this.onEvidenceSelected,
    this.repository,
    this.reviewService,
    this.initialBundle,
    this.skipInitialLoad = false,
    this.jobsRepository,
    this.onGenerate,
    this.onCancelGeneration,
    this.onTitleApplied,
    this.generating = false,
    this.reloadToken = 0,
  });

  final int recordingId;
  final ValueChanged<EvidenceLinkEntity> onEvidenceSelected;
  final AudioIntelligenceRepository? repository;
  final AudioIntelligenceReviewService? reviewService;
  final AudioIntelligenceBundle? initialBundle;
  final bool skipInitialLoad;
  final AudioIntelligenceJobsRepository? jobsRepository;
  final Future<void> Function(bool userConfirmedRetry)? onGenerate;
  final Future<void> Function()? onCancelGeneration;
  final VoidCallback? onTitleApplied;
  final bool generating;
  final int reloadToken;

  @override
  State<AudioIntelligenceSection> createState() =>
      _AudioIntelligenceSectionState();
}

class _AudioIntelligenceSectionState extends State<AudioIntelligenceSection> {
  late final AudioIntelligenceRepository _repository;
  late final AudioIntelligenceReviewService _reviewService;
  late final AudioIntelligenceJobsRepository _jobsRepository;
  AudioIntelligenceBundle? _bundle;
  AudioIntelligenceJobEntity? _latestJob;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? AudioIntelligenceRepository();
    _reviewService =
        widget.reviewService ??
        AudioIntelligenceReviewService(repository: _repository);
    _jobsRepository =
        widget.jobsRepository ?? AudioIntelligenceJobsRepository();
    _bundle = widget.initialBundle;
    if (widget.skipInitialLoad) {
      _loading = false;
    } else {
      unawaited(_load());
    }
  }

  @override
  void didUpdateWidget(covariant AudioIntelligenceSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadToken != widget.reloadToken) {
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    final results = await Future.wait<Object?>(<Future<Object?>>[
      _repository.findLatestForRecording(widget.recordingId),
      _jobsRepository.findLatestForRecording(widget.recordingId),
    ]);
    if (!mounted) return;
    setState(() {
      _bundle = results[0] as AudioIntelligenceBundle?;
      _latestJob = results[1] as AudioIntelligenceJobEntity?;
      _loading = false;
    });
  }

  Future<void> _open(AudioInsightEntity insight) async {
    final action = await showEvidenceReviewPanel(
      context: context,
      insight: insight,
      evidence:
          _bundle?.evidenceByInsight[insight.id] ??
          const <EvidenceLinkEntity>[],
      onEvidenceSelected: widget.onEvidenceSelected,
    );
    if (action == null || !mounted) return;
    try {
      switch (action) {
        case EvidenceReviewAction.edit:
          final result = await showAudioNoteEditor(
            context: context,
            insight: insight,
          );
          if (result == null) return;
          await _reviewService.edit(
            insightId: insight.id,
            body: result.body,
            actionOwner: result.actionOwner,
            actionDueAtMs: result.actionDueAtMs,
            clearActionOwner: result.clearActionOwner,
            clearActionDueAt: result.clearActionDueAt,
          );
        case EvidenceReviewAction.applyTitle:
          final bundle = _bundle;
          if (bundle == null) return;
          await _reviewService.applySuggestedTitle(
            noteId: bundle.note.id,
            title: insight.body,
          );
          widget.onTitleApplied?.call();
        case EvidenceReviewAction.reviewed:
          await _reviewService.markReviewed(insight.id);
        case EvidenceReviewAction.rejected:
          await _reviewService.reject(insight.id);
        case EvidenceReviewAction.published:
          await _reviewService.publish(insight.id);
        case EvidenceReviewAction.resolve:
          await _reviewService.setResolved(insight.id, resolved: true);
        case EvidenceReviewAction.reopen:
          await _reviewService.setResolved(insight.id, resolved: false);
      }
      await _load();
    } catch (error) {
      if (!mounted) return;
      GooToastScope.of(context).error('审核状态无法更新，请检查证据和当前状态');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: GooInlineLoader());
    final jobStatus = _buildJobStatus();
    final bundle = _bundle;
    if (bundle == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (jobStatus != null) ...<Widget>[
            jobStatus,
            const SizedBox(height: 8),
          ],
          const GooList(
            children: <Widget>[
              GooListItem(
                title: 'AI 音频洞察尚未生成',
                subtitle: '默认不会上传音频内容；云端直连需要先在设置中配置，并在每次生成前确认范围。',
                leadingIconName: GooIcons.security,
              ),
            ],
          ),
          if (widget.onGenerate != null) ...<Widget>[
            const SizedBox(height: 8),
            GooButton(
              onPressed: widget.generating
                  ? null
                  : () => unawaited(widget.onGenerate!(false)),
              child: const Text('生成音频纪要'),
            ),
          ],
        ],
      );
    }
    final topics = bundle.insights
        .where((insight) => insight.kind == AudioInsightKind.topic)
        .toList(growable: false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (jobStatus != null) ...<Widget>[
          jobStatus,
          const SizedBox(height: 8),
        ],
        Row(
          children: <Widget>[
            const GooText('音频洞察', variant: GooTextVariant.subtitle),
            const SizedBox(width: 8),
            GooTag(
              label: '审核状态：${_statusLabel(bundle.note.status.name)}',
              accent: GooTagAccent.blue,
            ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: <Widget>[
            GooTag(
              label: '${bundle.note.providerId} · ${bundle.note.modelId}',
              accent: GooTagAccent.blue,
            ),
            GooTag(
              label: _processingLocationLabel(bundle.note.processingLocation),
              accent: GooTagAccent.orange,
            ),
            GooTag(
              label: '模板：${bundle.note.templateId}',
              accent: GooTagAccent.green,
            ),
          ],
        ),
        if (bundle.note.suggestedTitle != null) ...<Widget>[
          const SizedBox(height: 8),
          GooList(
            children: <Widget>[
              GooListItem(
                title: bundle.note.suggestedTitle!,
                subtitle: 'AI 标题建议；不会自动覆盖当前音频标题',
                trailing: GooButton.text(
                  onPressed: () => unawaited(
                    _reviewService
                        .applySuggestedTitle(
                          noteId: bundle.note.id,
                          title: bundle.note.suggestedTitle!,
                        )
                        .then((_) {
                          widget.onTitleApplied?.call();
                        }),
                  ),
                  child: const Text('应用标题'),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: 12),
        ..._buildGroup(
          '摘要',
          bundle.insights.where(
            (insight) =>
                insight.kind == AudioInsightKind.summary ||
                insight.kind == AudioInsightKind.summaryKeyPoint ||
                insight.kind == AudioInsightKind.summaryDetailed,
          ),
        ),
        if (topics.isNotEmpty) ...<Widget>[
          const SizedBox(height: 12),
          AudioTopicTimeline(
            topics: topics,
            onSelected: (topic) => unawaited(_open(topic)),
          ),
        ],
        const SizedBox(height: 12),
        ..._buildGroup(
          '决策与行动',
          bundle.insights.where(
            (insight) =>
                insight.kind == AudioInsightKind.decision ||
                insight.kind == AudioInsightKind.action,
          ),
        ),
        const SizedBox(height: 12),
        ..._buildGroup(
          '风险与待确认',
          bundle.insights.where(
            (insight) =>
                insight.kind == AudioInsightKind.risk ||
                insight.kind == AudioInsightKind.unresolved,
          ),
        ),
      ],
    );
  }

  Widget? _buildJobStatus() {
    final job = _latestJob;
    if (job == null && !widget.generating) return null;
    final status = widget.generating
        ? AudioIntelligenceJobStatus.processing
        : job!.status;
    final label = switch (status) {
      AudioIntelligenceJobStatus.queued => '已排队',
      AudioIntelligenceJobStatus.processing => '正在生成',
      AudioIntelligenceJobStatus.completed => '生成完成',
      AudioIntelligenceJobStatus.failed => '生成失败',
      AudioIntelligenceJobStatus.canceled => '已取消',
      AudioIntelligenceJobStatus.recoveryUnknown => '上次请求结果未知',
    };
    final retryable =
        status == AudioIntelligenceJobStatus.failed ||
        status == AudioIntelligenceJobStatus.recoveryUnknown;
    return GooList(
      children: <Widget>[
        GooListItem(
          title: label,
          subtitle: switch (status) {
            AudioIntelligenceJobStatus.queued => '等待开始，不会在进程重启后重复扣费',
            AudioIntelligenceJobStatus.processing => '正在按有界批次处理，可随时取消',
            AudioIntelligenceJobStatus.completed => '结果已保存为可审核草稿',
            AudioIntelligenceJobStatus.failed => '没有保存半份纪要；可由你明确重试',
            AudioIntelligenceJobStatus.canceled => '音频原文和已有纪要保持不变',
            AudioIntelligenceJobStatus.recoveryUnknown => '可能已产生远端费用；应用不会自动重发',
          },
          trailing: widget.generating
              ? GooButton.text(
                  onPressed: widget.onCancelGeneration == null
                      ? null
                      : () => unawaited(widget.onCancelGeneration!()),
                  child: const Text('取消'),
                )
              : retryable && widget.onGenerate != null
              ? GooButton.text(
                  onPressed: () => unawaited(widget.onGenerate!(true)),
                  child: Text(
                    status == AudioIntelligenceJobStatus.recoveryUnknown
                        ? '确认并重试'
                        : '重试',
                  ),
                )
              : null,
        ),
      ],
    );
  }

  List<Widget> _buildGroup(String title, Iterable<AudioInsightEntity> values) {
    final items = values.toList(growable: false);
    if (items.isEmpty) return const <Widget>[];
    return <Widget>[
      GooText(title, variant: GooTextVariant.subtitle),
      const SizedBox(height: 8),
      GooList(children: items.map(_buildInsightItem).toList(growable: false)),
    ];
  }

  Widget _buildInsightItem(AudioInsightEntity insight) {
    final resolution =
        insight.kind == AudioInsightKind.risk ||
            insight.kind == AudioInsightKind.unresolved
        ? insight.resolutionState == AudioInsightResolutionState.resolved
              ? ' · 已解决'
              : ' · 待解决'
        : '';
    return GooListItem(
      title: insight.body,
      subtitle:
          '${_kindLabel(insight.kind)} · '
          '${insight.unsupported ? '无证据' : _statusLabel(insight.status.name)}'
          '$resolution',
      trailing: GooTag(
        label: insight.unsupported ? '未支持' : _statusLabel(insight.status.name),
        accent: insight.unsupported ? GooTagAccent.orange : GooTagAccent.green,
      ),
      onTap: () => unawaited(_open(insight)),
    );
  }
}

String _kindLabel(AudioInsightKind kind) => switch (kind) {
  AudioInsightKind.title => '标题建议',
  AudioInsightKind.summary => '摘要',
  AudioInsightKind.summaryKeyPoint => '要点摘要',
  AudioInsightKind.summaryDetailed => '详细纪要',
  AudioInsightKind.topic => '议题',
  AudioInsightKind.decision => '决策',
  AudioInsightKind.action => '行动项',
  AudioInsightKind.risk => '风险',
  AudioInsightKind.unresolved => '待确认',
};

String _statusLabel(String status) => switch (status) {
  'draft' => '草稿',
  'reviewed' => '已审核',
  'rejected' => '已驳回',
  'published' => '已发布',
  _ => status,
};

String _processingLocationLabel(String value) => switch (value) {
  'onDevice' || 'local' => '本机处理',
  'cloudDirect' || 'remote' => '云端直连',
  'pairedPc' => 'PC 配对',
  _ => value,
};
