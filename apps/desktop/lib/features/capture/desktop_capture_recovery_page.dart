import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import 'desktop_capture_controller.dart';
import 'desktop_capture_view_model.dart';

class DesktopCaptureRecoveryPage extends StatelessWidget {
  const DesktopCaptureRecoveryPage({
    super.key,
    required this.controller,
    required this.model,
  });

  final DesktopCaptureUiController controller;
  final DesktopCaptureViewModel model;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        const GooAppBar.primary(
          title: '发现未完成的录音',
          subtitle: '已验证最后安全 chunk；请逐个保留或删除，不会批量处理未知目录',
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 840),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  if (model.error != null) ...[
                    GooCard(
                      fillWidth: true,
                      variant: GooCardVariant.filled,
                      child: GooText(model.error!),
                    ),
                    const SizedBox(height: 16),
                  ],
                  GooList(
                    children: model.recoveries
                        .map(
                          (recovery) => GooListItem(
                            title: '可恢复会议 ${_suffix(recovery.sessionId)}',
                            subtitle:
                                '${recovery.validatedChunkCount} 个已验证 chunk · '
                                '${_duration(recovery.captureTimelineMs)} · '
                                '${recovery.healthyTrackCount}/2 健康轨道 · '
                                '${recovery.gapCount} 个 gap · '
                                '最后安全点 ${_duration(recovery.lastSafeChunkMs)} · '
                                '${_mib(recovery.storageBytes)} MiB · '
                                '${recovery.state == 'partial_capture' ? '部分轨道' : '意外中断'}',
                            leadingIconName: GooIcons.refresh,
                            trailing: Wrap(
                              spacing: 8,
                              children: <Widget>[
                                GooButton.text(
                                  onPressed: () => _confirmDiscard(
                                    context,
                                    recovery.sessionId,
                                  ),
                                  child: const GooText('删除'),
                                ),
                                GooButton(
                                  onPressed: () => controller.keepRecovered(
                                    recovery.sessionId,
                                  ),
                                  child: const GooText('保留并处理'),
                                ),
                              ],
                            ),
                          ),
                        )
                        .toList(growable: false),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _confirmDiscard(BuildContext context, String sessionId) async {
    final confirmed = await showGooDialog<bool>(
      context: context,
      builder: (_) => const GooDialog.confirmation(
        title: '删除这一个恢复会话？',
        description: '只删除当前明确列出的私有会话目录；此操作无法恢复，其他录音不受影响。',
        actions: <GooDialogAction>[
          GooDialogAction(label: '取消', result: false),
          GooDialogAction(
            label: '删除会话',
            result: true,
            tone: GooDialogActionTone.destructive,
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await controller.discardRecovered(sessionId);
    }
  }

  static String _suffix(String value) =>
      value.length <= 8 ? value : value.substring(value.length - 8);

  static String _duration(int milliseconds) {
    final duration = Duration(milliseconds: milliseconds);
    final minutes = duration.inMinutes;
    final seconds = duration.inSeconds.remainder(60);
    return '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }

  static String _mib(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(1);
}
