import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_components/flutter_components.dart';

import 'desktop_capture_controller.dart';
import 'desktop_capture_view_model.dart';
import 'widgets/capture_status_row.dart';

class DesktopRecordingWorkspace extends StatelessWidget {
  const DesktopRecordingWorkspace({
    super.key,
    required this.controller,
    required this.model,
  });

  final DesktopCaptureUiController controller;
  final DesktopCaptureViewModel model;

  @override
  Widget build(BuildContext context) {
    if (model.phase == DesktopCapturePhase.completed) {
      return Column(
        children: <Widget>[
          const GooAppBar.primary(title: '录音已安全保存'),
          Expanded(
            child: Center(
              child: GooResult(
                title: '会议已进入正式转写队列',
                description: model.microphoneOnly
                    ? '麦克风音频已提交。完整 Qwen3 结果成功后才会成为正式转写。'
                    : '双轨音频已提交。实时草稿仍可追溯，完整 Qwen3 结果成功后才会成为正式转写。',
                buttonLabel: '返回会议资料库',
                onButtonPressed: controller.reset,
              ),
            ),
          ),
        ],
      );
    }
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(
          LogicalKeyboardKey.space,
          meta: true,
        ): model.phase == DesktopCapturePhase.paused
            ? controller.resume
            : controller.pause,
      },
      child: Focus(
        autofocus: true,
        child: Column(
          children: <Widget>[
            GooAppBar.primary(
              title: model.phase == DesktopCapturePhase.stopping
                  ? '正在安全停止'
                  : model.phase == DesktopCapturePhase.paused
                  ? '电脑会议已暂停'
                  : '电脑会议录音中',
              subtitle: model.microphoneOnly
                  ? '仅麦克风兼容模式；关闭主窗口不会自动停止录音'
                  : '系统音频与麦克风双轨；关闭主窗口不会自动停止录音',
              pageLoadingMode: model.phase == DesktopCapturePhase.stopping
                  ? GooPageLoadingMode.recycle
                  : null,
              pageLoadingAnimated:
                  model.phase == DesktopCapturePhase.stopping &&
                  !MediaQuery.disableAnimationsOf(context),
            ),
            Expanded(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 940),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(24, 24, 24, 48),
                    children: <Widget>[
                      Semantics(
                        liveRegion: true,
                        label:
                            '录音时长 ${_duration(model.elapsed)}，'
                            '${model.phase == DesktopCapturePhase.paused ? '已暂停' : '录音中'}',
                        child: GooCard(
                          fillWidth: true,
                          child: Column(
                            children: <Widget>[
                              GooText(
                                _duration(model.elapsed),
                                styleToken: GooTextStyleToken.displayM,
                              ),
                              const SizedBox(height: 8),
                              GooTag(
                                label: model.phase == DesktopCapturePhase.paused
                                    ? '已暂停'
                                    : model.partialCapture
                                    ? '部分轨道仍在录制'
                                    : model.microphoneOnly
                                    ? '仅麦克风录音中'
                                    : '录音中',
                                accent:
                                    model.phase == DesktopCapturePhase.paused ||
                                        model.partialCapture
                                    ? GooTagAccent.orange
                                    : GooTagAccent.red,
                                variant: GooTagVariant.capsule,
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      if (model.snapshot?.interruptionReason != null) ...[
                        Semantics(
                          liveRegion: true,
                          label: _interruptionLabel(
                            model.snapshot!.interruptionReason!,
                          ),
                          child: GooCard(
                            fillWidth: true,
                            variant: GooCardVariant.filled,
                            child: GooText(
                              _interruptionLabel(
                                model.snapshot!.interruptionReason!,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],
                      GooList(
                        children: <Widget>[
                          CaptureStatusRow(
                            title: '系统音频轨',
                            description: model.microphoneOnly
                                ? '兼容模式未启用；macOS 14.2 或更高版本支持'
                                : model.systemAudioHealthy
                                ? '独立权威轨道正在写入'
                                : '当前不可用；请检查 partial capture 提示',
                            available: model.systemAudioHealthy,
                            iconName: GooIcons.audio,
                            level: model.snapshot?.systemAudioLevel ?? 0,
                            trailing: model.microphoneOnly
                                ? const GooTag(
                                    label: '未启用',
                                    accent: GooTagAccent.neutral,
                                    variant: GooTagVariant.capsule,
                                  )
                                : null,
                          ),
                          CaptureStatusRow(
                            title: '麦克风轨',
                            description: model.microphoneHealthy
                                ? '所选麦克风独立写入'
                                : '当前不可用；另一健康轨会继续录制',
                            available: model.microphoneHealthy,
                            iconName: GooIcons.microphone,
                            level: model.snapshot?.microphoneLevel ?? 0,
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      GooCard(
                        fillWidth: true,
                        variant: GooCardVariant.filled,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Row(
                              children: <Widget>[
                                const Expanded(
                                  child: GooText(
                                    '实时草稿 · 可能变化',
                                    variant: GooTextVariant.heading,
                                  ),
                                ),
                                GooTag(
                                  label: model.captionError != null
                                      ? '已降级'
                                      : model.captionEnabled
                                      ? 'SenseVoice'
                                      : '未启用',
                                  accent: model.captionError != null
                                      ? GooTagAccent.orange
                                      : GooTagAccent.blue,
                                  variant: GooTagVariant.capsule,
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Semantics(
                              liveRegion: true,
                              label: model.draftText.isEmpty
                                  ? '等待第一句实时草稿'
                                  : '最新实时草稿 ${model.draftText}',
                              child: GooText(
                                model.captionError ??
                                    (model.draftText.isEmpty
                                        ? '等待完整句子；不会显示未经 VAD 结束的 token partial。'
                                        : model.draftText),
                              ),
                            ),
                            if (model.captionError != null) ...[
                              const SizedBox(height: 12),
                              GooButton.text(
                                onPressed:
                                    model.phase == DesktopCapturePhase.stopping
                                    ? null
                                    : controller.restartCaptions,
                                child: const GooText('重启实时草稿'),
                              ),
                            ],
                            if (model.captionBacklogBytes > 0) ...[
                              const SizedBox(height: 12),
                              GooProgress(
                                value: (model.captionBacklogBytes / 960000)
                                    .clamp(0, 1)
                                    .toDouble(),
                                status: model.captionBacklogBytes > 640000
                                    ? GooProgressStatus.failed
                                    : GooProgressStatus.active,
                                semanticLabel: '实时草稿积压',
                                liveRegion: true,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (model.error != null) ...[
                        const SizedBox(height: 16),
                        GooCard(
                          fillWidth: true,
                          variant: GooCardVariant.filled,
                          child: GooText(model.error!),
                        ),
                      ],
                      const SizedBox(height: 24),
                      Wrap(
                        alignment: WrapAlignment.center,
                        spacing: 12,
                        runSpacing: 12,
                        children: <Widget>[
                          GooButton(
                            key: const ValueKey('capture_pause_resume_button'),
                            iconName: model.phase == DesktopCapturePhase.paused
                                ? GooIcons.playerPlay
                                : GooIcons.playerPause,
                            variant: GooButtonVariant.secondary,
                            onPressed:
                                model.phase == DesktopCapturePhase.stopping
                                ? null
                                : model.phase == DesktopCapturePhase.paused
                                ? controller.resume
                                : controller.pause,
                            child: GooText(
                              model.phase == DesktopCapturePhase.paused
                                  ? '继续录音'
                                  : '暂停',
                            ),
                          ),
                          GooButton(
                            key: const ValueKey('capture_stop_button'),
                            iconName: GooIcons.close,
                            variant: GooButtonVariant.destructive,
                            onPressed:
                                model.phase == DesktopCapturePhase.stopping
                                ? null
                                : () => _confirmStop(context),
                            child: const GooText('停止并保存'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmStop(BuildContext context) async {
    final confirmed = await showGooDialog<bool>(
      context: context,
      builder: (_) => GooDialog.confirmation(
        title: '停止本次电脑会议？',
        description: model.microphoneOnly
            ? '将先停止新音频、最终化并提交麦克风单轨，再关闭实时草稿，最后排入 Qwen3 正式转写。'
            : '将先停止新音频、最终化并提交双轨，再关闭实时草稿，最后排入 Qwen3 正式转写。',
        actions: const <GooDialogAction>[
          GooDialogAction(label: '继续录音', result: false),
          GooDialogAction(
            label: '停止并保存',
            result: true,
            tone: GooDialogActionTone.destructive,
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.stop();
  }

  static String _duration(Duration value) {
    final hours = value.inHours;
    final minutes = value.inMinutes.remainder(60);
    final seconds = value.inSeconds.remainder(60);
    return hours > 0
        ? '${hours.toString().padLeft(2, '0')}:'
              '${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}'
        : '${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}';
  }

  static String _interruptionLabel(String reason) => switch (reason) {
    'system_sleep' => 'Mac 即将睡眠，录音已安全暂停。',
    'system_wake_requires_resume' => 'Mac 已从睡眠中唤醒；请确认音频设备后点击继续录音。',
    'system_sleep_pause_failed' => '系统睡眠时未能完整暂停；已保留可恢复录音，请检查轨道状态。',
    _ => '录音已因系统状态变化暂停；请检查轨道后继续。',
  };
}
