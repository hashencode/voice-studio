import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

class CloudProcessingConsentRequest {
  const CloudProcessingConsentRequest({
    required this.providerLabel,
    required this.modelId,
    required this.inputStartMs,
    required this.inputEndMs,
    required this.segmentCount,
    required this.estimatedRequestCount,
    required this.speakerLabelsIncluded,
    this.consentVersion = 1,
  });

  final String providerLabel;
  final String modelId;
  final int inputStartMs;
  final int inputEndMs;
  final int segmentCount;
  final int estimatedRequestCount;
  final bool speakerLabelsIncluded;
  final int consentVersion;

  String get payloadSummary {
    final labels = speakerLabelsIncluded ? '，含说话人标签' : '';
    return '$segmentCount 个转写片段$labels，'
        '${_clock(inputStartMs)}–${_clock(inputEndMs)}，'
        '预计 $estimatedRequestCount 次请求';
  }
}

class CloudProcessingConsentReceipt {
  const CloudProcessingConsentReceipt({
    required this.version,
    required this.grantedAtMs,
    required this.payloadSummary,
  });

  final int version;
  final int grantedAtMs;
  final String payloadSummary;
}

Future<CloudProcessingConsentReceipt?> showCloudProcessingConsentPanel({
  required BuildContext context,
  required CloudProcessingConsentRequest request,
  VoidCallback? onOpenDataPolicy,
}) {
  return showGooPanel<CloudProcessingConsentReceipt>(
    context: context,
    title: '确认云端处理',
    semanticLabel: '确认将当前会议文本发送到云端',
    builder: (context, controller, scrollController) {
      return CloudProcessingConsentPanel(
        request: request,
        scrollController: scrollController,
        onOpenDataPolicy: onOpenDataPolicy,
        onCancel: controller.close,
        onConfirm: () {
          controller.closeWithResult(
            CloudProcessingConsentReceipt(
              version: request.consentVersion,
              grantedAtMs: DateTime.now().millisecondsSinceEpoch,
              payloadSummary: request.payloadSummary,
            ),
          );
        },
      );
    },
  );
}

class CloudProcessingConsentPanel extends StatelessWidget {
  const CloudProcessingConsentPanel({
    super.key,
    required this.request,
    required this.onCancel,
    required this.onConfirm,
    this.scrollController,
    this.onOpenDataPolicy,
  });

  final CloudProcessingConsentRequest request;
  final VoidCallback onCancel;
  final VoidCallback onConfirm;
  final ScrollController? scrollController;
  final VoidCallback? onOpenDataPolicy;

  @override
  Widget build(BuildContext context) {
    return ListView(
      controller: scrollController,
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        const GooTopTip.icon(
          message: '会议文本将离开设备',
          semanticLabel: '提醒：会议文本将离开设备',
          dismissible: false,
          variant: GooTopTipVariant.warning,
          maxLines: 1,
        ),
        const SizedBox(height: 16),
        GooList(
          style: GooListStyle.grouped,
          children: <Widget>[
            GooListItem(title: '处理位置', subtitle: '云端直连'),
            GooListItem(
              title: '提供商与模型',
              subtitle: '${request.providerLabel} · ${request.modelId}',
            ),
            GooListItem(title: '发送内容', subtitle: request.payloadSummary),
          ],
        ),
        const SizedBox(height: 16),
        const GooText(
          '只发送上面列出的转写文本和时间信息，不发送音频、附件、其他会议或诊断数据。'
          '数据将按第三方提供商的条款处理。',
          variant: GooTextVariant.body,
        ),
        if (onOpenDataPolicy != null) ...<Widget>[
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: GooButton(
              variant: GooButtonVariant.secondary,
              onPressed: onOpenDataPolicy,
              child: const Text('查看第三方数据政策'),
            ),
          ),
        ],
        const SizedBox(height: 24),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          alignment: WrapAlignment.end,
          children: <Widget>[
            GooButton(
              variant: GooButtonVariant.secondary,
              onPressed: onCancel,
              child: const Text('取消'),
            ),
            GooButton(
              onPressed: onConfirm,
              semanticLabel: '同意发送当前显示范围的会议文本',
              child: const Text('同意并生成'),
            ),
          ],
        ),
      ],
    );
  }
}

String _clock(int milliseconds) {
  final duration = Duration(milliseconds: milliseconds);
  final hours = duration.inHours;
  final minutes = duration.inMinutes.remainder(60);
  final seconds = duration.inSeconds.remainder(60);
  if (hours > 0) {
    return '${hours.toString().padLeft(2, '0')}:'
        '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }
  return '${minutes.toString().padLeft(2, '0')}:'
      '${seconds.toString().padLeft(2, '0')}';
}
