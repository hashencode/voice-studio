import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../model/evidence_link_entity.dart';
import '../model/meeting_insight_entity.dart';

enum EvidenceReviewAction { reviewed, rejected, published }

Future<EvidenceReviewAction?> showEvidenceReviewPanel({
  required BuildContext context,
  required MeetingInsightEntity insight,
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
          if (insight.kind == MeetingInsightKind.action) ...<Widget>[
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
                onPressed: insight.status == MeetingInsightStatus.draft
                    ? () => controller.closeWithResult(
                        EvidenceReviewAction.reviewed,
                      )
                    : null,
                child: const Text('标记已审核'),
              ),
              GooButton(
                variant: GooButtonVariant.secondary,
                onPressed:
                    insight.status == MeetingInsightStatus.draft ||
                        insight.status == MeetingInsightStatus.reviewed
                    ? () => controller.closeWithResult(
                        EvidenceReviewAction.rejected,
                      )
                    : null,
                child: const Text('驳回'),
              ),
              GooButton(
                variant: GooButtonVariant.success,
                onPressed:
                    insight.status == MeetingInsightStatus.reviewed &&
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

String _kindLabel(MeetingInsightKind kind) => switch (kind) {
  MeetingInsightKind.summary => '摘要',
  MeetingInsightKind.decision => '决策',
  MeetingInsightKind.action => '行动项',
  MeetingInsightKind.risk => '风险',
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
