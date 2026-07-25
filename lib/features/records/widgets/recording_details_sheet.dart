import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../../../app/router.dart';
import '../../meetings/meeting_detail_page.dart';
import '../../shared/utils/formatters.dart';
import '../../transcription/model/transcription_job_entity.dart';

Future<void> showRecordingDetailsSheet({
  required BuildContext context,
  required String title,
  required String path,
  required int durationMs,
  required int createdAtMs,
  required TranscriptionJobEntity? latestJob,
  int? recordingId,
}) async {
  final destination = await showGooPanel<String>(
    context: context,
    title: title,
    semanticLabel: '$title 录音详情',
    builder:
        (
          BuildContext _,
          GooPanelController<String> controller,
          ScrollController scrollController,
        ) {
          return ListView(
            controller: scrollController,
            padding: EdgeInsets.zero,
            children: <Widget>[
              GooText('时长: ${formatDurationMs(durationMs)}'),
              const SizedBox(height: 8),
              GooText(
                '创建时间: ${DateTime.fromMillisecondsSinceEpoch(createdAtMs)}',
              ),
              const SizedBox(height: 8),
              GooText('路径: $path', selectable: true),
              if (latestJob != null) ...<Widget>[
                const SizedBox(height: 12),
                GooText(
                  '最近转写: ${_statusLabel(latestJob.status)} · '
                  '${_stageLabel(latestJob)} · ${_modeLabel(latestJob)}',
                  variant: GooTextVariant.subtitle,
                ),
                const SizedBox(height: 6),
                GooText(
                  latestJob.resultText?.trim().isNotEmpty == true
                      ? latestJob.resultText!
                      : (latestJob.errorMessage?.trim().isNotEmpty == true
                            ? latestJob.errorMessage!
                            : latestJob.recordingPath),
                  maxLines: 6,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              if (latestJob != null &&
                  latestJob.status != 'completed') ...<Widget>[
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: GooButton.text(
                    iconName: GooIcons.refresh,
                    onPressed: () =>
                        controller.closeWithResult(AppRoutes.transcription),
                    child: Text(
                      latestJob.status == 'failed' ||
                              latestJob.status == 'canceled'
                          ? '查看并重试转写'
                          : '查看转写进度',
                    ),
                  ),
                ),
              ],
              if (recordingId != null && recordingId > 0) ...<Widget>[
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: GooButton(
                    iconName: GooIcons.play,
                    onPressed: () =>
                        controller.closeWithResult(AppRoutes.meetingDetail),
                    child: const Text('打开会议工作区'),
                  ),
                ),
              ],
            ],
          );
        },
  );
  if (!context.mounted || destination == null) return;
  if (destination == AppRoutes.meetingDetail) {
    await Navigator.of(context).pushNamed(
      destination,
      arguments: MeetingDetailArguments(recordingId: recordingId!),
    );
    return;
  }
  await Navigator.of(context).pushNamed(destination);
}

String _modeLabel(TranscriptionJobEntity job) {
  final String mode = switch (job.recordingMode) {
    'realtime' => '实时',
    'standard' => '标准',
    _ => job.recordingMode,
  };
  final String source = switch (job.source) {
    'standard_offline' => '离线全文',
    'realtime_final' => '实时分段',
    'realtime_fallback_offline' => '实时兜底离线',
    _ => job.source,
  };
  return '$mode/$source';
}

String _statusLabel(String status) {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'processing':
      return '处理中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return status;
  }
}

String _stageLabel(TranscriptionJobEntity job) {
  final stage = job.failureStage ?? job.stage;
  return switch (stage) {
    'queued' => '等待队列',
    'transcode' => '音频转码',
    'vad' => '语音检测',
    'model' => '模型准备',
    'decode' => '语音识别',
    'punctuation' => '标点恢复',
    'persist' => '保存结果',
    'completed' => '结果已保存',
    'cancellation' || 'canceled' => '任务取消',
    'failed' => '处理失败',
    _ => stage,
  };
}
