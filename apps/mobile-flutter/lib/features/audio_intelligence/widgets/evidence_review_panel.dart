import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../model/evidence_link_entity.dart';
import '../model/audio_insight_entity.dart';

enum EvidenceReviewAction {
  edit,
  applyTitle,
  reviewed,
  rejected,
  published,
  resolve,
  reopen,
}

Future<EvidenceReviewAction?> showEvidenceReviewPanel({
  required BuildContext context,
  required AudioInsightEntity insight,
  required List<EvidenceLinkEntity> evidence,
  required ValueChanged<EvidenceLinkEntity> onEvidenceSelected,
}) {
  return showGooPanel<EvidenceReviewAction>(
    context: context,
    title: _kindLabel(insight.kind),
    initialDetentId: 'default',
    builder: (context, controller, scrollController) {
      return ListView(
        controller: scrollController,
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          GooText(insight.body, variant: GooTextVariant.body),
          const SizedBox(height: 12),
          GooTag(
            label: insight.unsupported ? '无证据，不可发布' : '有可播放证据',
            accent: insight.unsupported
                ? GooTagAccent.orange
                : GooTagAccent.green,
          ),
          if (insight.kind == AudioInsightKind.action) ...<Widget>[
            const SizedBox(height: 8),
            GooText(
              '负责人：${insight.unresolvedOwner ? '待确认' : insight.actionOwner}\n'
              '截止时间：${insight.unresolvedDueDate ? '待确认' : _date(insight.actionDueAtMs)}',
              variant: GooTextVariant.caption,
            ),
          ],
          const SizedBox(height: 16),
          const GooText('证据', variant: GooTextVariant.subtitle),
          const SizedBox(height: 8),
          if (evidence.isEmpty)
            const GooResult.preset(
              preset: GooResultPreset.noContent,
              title: '此条目没有证据',
              description: '可保留为未支持草稿，但不能发布为已确认事实。',
            )
          else
            GooList(
              children: evidence
                  .map((link) {
                    return GooListItem(
                      title: '${_clock(link.startMs)} – ${_clock(link.endMs)}',
                      subtitle: '转写片段 #${link.segmentId}',
                      showGuide: true,
                      onTap: () {
                        onEvidenceSelected(link);
                        controller.close();
                      },
                    );
                  })
                  .toList(growable: false),
            ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              GooButton(
                variant: GooButtonVariant.secondary,
                onPressed: () =>
                    controller.closeWithResult(EvidenceReviewAction.edit),
                child: const Text('编辑'),
              ),
              if (insight.kind == AudioInsightKind.title)
                GooButton(
                  variant: GooButtonVariant.secondary,
                  onPressed: () => controller.closeWithResult(
                    EvidenceReviewAction.applyTitle,
                  ),
                  child: const Text('应用为音频标题'),
                ),
              if (insight.kind == AudioInsightKind.risk ||
                  insight.kind == AudioInsightKind.unresolved)
                GooButton(
                  variant: GooButtonVariant.secondary,
                  onPressed: () => controller.closeWithResult(
                    insight.resolutionState ==
                            AudioInsightResolutionState.resolved
                        ? EvidenceReviewAction.reopen
                        : EvidenceReviewAction.resolve,
                  ),
                  child: Text(
                    insight.resolutionState ==
                            AudioInsightResolutionState.resolved
                        ? '重新打开'
                        : '标记已解决',
                  ),
                ),
              GooButton(
                onPressed: insight.status == AudioInsightStatus.draft
                    ? () => controller.closeWithResult(
                        EvidenceReviewAction.reviewed,
                      )
                    : null,
                child: const Text('标记已审核'),
              ),
              GooButton(
                variant: GooButtonVariant.secondary,
                onPressed:
                    insight.status == AudioInsightStatus.draft ||
                        insight.status == AudioInsightStatus.reviewed
                    ? () => controller.closeWithResult(
                        EvidenceReviewAction.rejected,
                      )
                    : null,
                child: const Text('驳回'),
              ),
              GooButton(
                variant: GooButtonVariant.success,
                onPressed:
                    insight.status == AudioInsightStatus.reviewed &&
                        !insight.unsupported &&
                        evidence.isNotEmpty
                    ? () => controller.closeWithResult(
                        EvidenceReviewAction.published,
                      )
                    : null,
                child: const Text('发布'),
              ),
            ],
          ),
        ],
      );
    },
  );
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

String _clock(int milliseconds) {
  final duration = Duration(milliseconds: milliseconds);
  return '${duration.inMinutes.toString().padLeft(2, '0')}:'
      '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}';
}

String _date(int? milliseconds) {
  if (milliseconds == null) return '待确认';
  return DateTime.fromMillisecondsSinceEpoch(milliseconds).toLocal().toString();
}
