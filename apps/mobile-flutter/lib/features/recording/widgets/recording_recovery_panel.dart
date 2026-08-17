import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../engine/recorder_port.dart';

class RecordingRecoveryPanel extends StatefulWidget {
  const RecordingRecoveryPanel({
    super.key,
    required this.candidates,
    required this.onRecover,
    required this.onDiscard,
    required this.onAllResolved,
  });

  final List<RecordingRecoveryCandidate> candidates;
  final Future<bool> Function(String sessionId) onRecover;
  final Future<bool> Function(String sessionId) onDiscard;
  final VoidCallback onAllResolved;

  @override
  State<RecordingRecoveryPanel> createState() => _RecordingRecoveryPanelState();
}

class _RecordingRecoveryPanelState extends State<RecordingRecoveryPanel> {
  late final List<RecordingRecoveryCandidate> _candidates =
      List<RecordingRecoveryCandidate>.of(widget.candidates);
  final Set<String> _busySessionIds = <String>{};

  Future<void> _resolve(
    RecordingRecoveryCandidate candidate, {
    required bool recover,
  }) async {
    if (_busySessionIds.contains(candidate.sessionId)) return;
    setState(() {
      _busySessionIds.add(candidate.sessionId);
    });
    final bool succeeded = recover
        ? await widget.onRecover(candidate.sessionId)
        : await widget.onDiscard(candidate.sessionId);
    if (!mounted) return;
    setState(() {
      _busySessionIds.remove(candidate.sessionId);
      if (succeeded) {
        _candidates.removeWhere(
          (item) => item.sessionId == candidate.sessionId,
        );
      }
    });
    if (_candidates.isEmpty) {
      widget.onAllResolved();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_candidates.isEmpty) {
      return const GooResult.preset(
        preset: GooResultPreset.noContent,
        title: '没有待处理录音',
        description: '所有临时录音都已恢复或清理。',
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: <Widget>[
        const GooText(
          '检测到上次异常退出留下的录音。可恢复的文件会保存为正式音频；无效文件只能安全清理。',
          variant: GooTextVariant.body,
          tone: GooTextTone.secondary,
        ),
        const SizedBox(height: 16),
        GooList(
          style: GooListStyle.grouped,
          children: _candidates.map(_buildCandidate).toList(growable: false),
        ),
      ],
    );
  }

  Widget _buildCandidate(RecordingRecoveryCandidate candidate) {
    final bool busy = _busySessionIds.contains(candidate.sessionId);
    final String status = candidate.canRecover ? '可以恢复' : '文件无效';
    final String duration = _formatDuration(candidate.durationMs);
    return GooListItem(
      title: '未完成录音 · $duration',
      subtitle: '$status · 内容仅保存在本机',
      trailingMaxWidth: const GooListItemTrailingWidth.auto(),
      trailing: Wrap(
        spacing: 4,
        children: <Widget>[
          if (candidate.canRecover)
            GooButton.text(
              disabled: busy,
              onPressed: () => _resolve(candidate, recover: true),
              child: GooText(busy ? '处理中' : '恢复'),
            ),
          GooButton.text(
            disabled: busy,
            onPressed: () => _resolve(candidate, recover: false),
            child: const GooText('清理'),
          ),
        ],
      ),
    );
  }

  String _formatDuration(int durationMs) {
    final int totalSeconds = durationMs ~/ 1000;
    final int minutes = totalSeconds ~/ 60;
    final int seconds = totalSeconds % 60;
    return '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }
}
