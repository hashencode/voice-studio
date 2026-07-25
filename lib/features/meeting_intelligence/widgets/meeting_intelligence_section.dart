import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../model/evidence_link_entity.dart';
import '../model/meeting_insight_entity.dart';
import '../repository/meeting_intelligence_repository.dart';
import '../service/meeting_intelligence_review_service.dart';
import 'evidence_review_panel.dart';

class MeetingIntelligenceSection extends StatefulWidget {
  const MeetingIntelligenceSection({
    super.key,
    required this.recordingId,
    required this.onEvidenceSelected,
    this.repository,
    this.reviewService,
    this.initialBundle,
    this.skipInitialLoad = false,
  });

  final int recordingId;
  final ValueChanged<EvidenceLinkEntity> onEvidenceSelected;
  final MeetingIntelligenceRepository? repository;
  final MeetingIntelligenceReviewService? reviewService;
  final MeetingIntelligenceBundle? initialBundle;
  final bool skipInitialLoad;

  @override
  State<MeetingIntelligenceSection> createState() =>
      _MeetingIntelligenceSectionState();
}

class _MeetingIntelligenceSectionState
    extends State<MeetingIntelligenceSection> {
  late final MeetingIntelligenceRepository _repository;
  late final MeetingIntelligenceReviewService _reviewService;
  MeetingIntelligenceBundle? _bundle;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? MeetingIntelligenceRepository();
    _reviewService =
        widget.reviewService ??
        MeetingIntelligenceReviewService(repository: _repository);
    _bundle = widget.initialBundle;
    if (widget.skipInitialLoad) {
      _loading = false;
    } else {
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    final bundle = await _repository.findLatestForRecording(widget.recordingId);
    if (!mounted) return;
    setState(() {
      _bundle = bundle;
      _loading = false;
    });
  }

  Future<void> _open(MeetingInsightEntity insight) async {
    final action = await showEvidenceReviewPanel(
      context: context,
      insight: insight,
      evidence:
          _bundle?.evidenceByInsight[insight.id] ??
          const <EvidenceLinkEntity>[],
      onEvidenceSelected: widget.onEvidenceSelected,
    );
    if (action == null) return;
    try {
      switch (action) {
        case EvidenceReviewAction.reviewed:
          await _reviewService.markReviewed(insight.id);
        case EvidenceReviewAction.rejected:
          await _reviewService.reject(insight.id);
        case EvidenceReviewAction.published:
          await _reviewService.publish(insight.id);
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
    final bundle = _bundle;
    if (bundle == null) {
      return const GooList(
        children: <Widget>[
          GooListItem(
            title: 'AI 会议洞察尚未生成',
            subtitle: '当前仅提供证据与审核基础；未配置生产提供商，也不会上传会议内容。',
            leadingIconName: GooIcons.security,
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            const GooText('会议洞察', variant: GooTextVariant.subtitle),
            const SizedBox(width: 8),
            GooTag(
              label: '审核状态：${_statusLabel(bundle.note.status.name)}',
              accent: GooTagAccent.blue,
            ),
          ],
        ),
        const SizedBox(height: 8),
        GooList(
          children: bundle.insights
              .map((insight) {
                return GooListItem(
                  title: insight.body,
                  subtitle:
                      '${_kindLabel(insight.kind)} · '
                      '${insight.unsupported ? '无证据' : _statusLabel(insight.status.name)}',
                  trailing: GooTag(
                    label: insight.unsupported
                        ? '未支持'
                        : _statusLabel(insight.status.name),
                    accent: insight.unsupported
                        ? GooTagAccent.orange
                        : GooTagAccent.green,
                  ),
                  onTap: () => unawaited(_open(insight)),
                );
              })
              .toList(growable: false),
        ),
      ],
    );
  }
}

String _kindLabel(MeetingInsightKind kind) => switch (kind) {
  MeetingInsightKind.summary => '摘要',
  MeetingInsightKind.decision => '决策',
  MeetingInsightKind.action => '行动项',
  MeetingInsightKind.risk => '风险',
};

String _statusLabel(String status) => switch (status) {
  'draft' => '草稿',
  'reviewed' => '已审核',
  'rejected' => '已驳回',
  'published' => '已发布',
  _ => status,
};
