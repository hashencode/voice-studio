import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../service/meeting_playback_service.dart';

class MeetingPlayerControls extends StatelessWidget {
  const MeetingPlayerControls({
    super.key,
    required this.snapshot,
    required this.onToggle,
    required this.onSeek,
    required this.onSkip,
    required this.onSpeed,
  });

  final MeetingPlaybackSnapshot snapshot;
  final VoidCallback onToggle;
  final ValueChanged<Duration> onSeek;
  final ValueChanged<Duration> onSkip;
  final ValueChanged<double> onSpeed;

  @override
  Widget build(BuildContext context) {
    if (snapshot.error != null) {
      return GooResult.preset(
        preset: GooResultPreset.notFound,
        title: '音频加载失败',
        description: snapshot.error,
      );
    }
    final totalMs = snapshot.duration.inMilliseconds;
    final max = totalMs <= 0 ? 1.0 : totalMs.toDouble();
    final value = snapshot.position.inMilliseconds.clamp(0, max).toDouble();
    return Semantics(
      container: true,
      label: '会议音频播放器',
      child: GooList(
        style: GooListStyle.grouped,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Column(
              children: <Widget>[
                GooSlider(
                  value: value,
                  max: max,
                  onChanged: snapshot.initialized
                      ? (next) => onSeek(Duration(milliseconds: next.round()))
                      : null,
                  semanticLabel: '播放进度',
                  semanticFormatter: (position) =>
                      '${_clock(position.round())}，总时长 ${_clock(totalMs)}',
                ),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: <Widget>[
                    GooText(
                      _clock(snapshot.position.inMilliseconds),
                      variant: GooTextVariant.caption,
                    ),
                    GooText(_clock(totalMs), variant: GooTextVariant.caption),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
            child: Wrap(
              alignment: WrapAlignment.center,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                GooButton.text(
                  onPressed: snapshot.initialized
                      ? () => onSkip(const Duration(seconds: -10))
                      : null,
                  semanticLabel: '后退十秒',
                  child: const Text('-10 秒'),
                ),
                GooButton.icon(
                  iconName: snapshot.playing ? GooIcons.pause : GooIcons.play,
                  onPressed: snapshot.initialized ? onToggle : null,
                  semanticLabel: snapshot.playing ? '暂停' : '播放',
                ),
                GooButton.text(
                  onPressed: snapshot.initialized
                      ? () => onSkip(const Duration(seconds: 10))
                      : null,
                  semanticLabel: '前进十秒',
                  child: const Text('+10 秒'),
                ),
                PopupMenuButton<double>(
                  tooltip: '播放速度',
                  initialValue: snapshot.speed,
                  onSelected: onSpeed,
                  itemBuilder: (_) => const <PopupMenuEntry<double>>[
                    PopupMenuItem(value: 0.5, child: Text('0.5×')),
                    PopupMenuItem(value: 1, child: Text('1.0×')),
                    PopupMenuItem(value: 1.25, child: Text('1.25×')),
                    PopupMenuItem(value: 1.5, child: Text('1.5×')),
                    PopupMenuItem(value: 2, child: Text('2.0×')),
                  ],
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text('${snapshot.speed}×'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _clock(int milliseconds) {
    final duration = Duration(milliseconds: milliseconds);
    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60);
    final seconds = duration.inSeconds.remainder(60);
    return hours > 0
        ? '$hours:${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}'
        : '${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}';
  }
}
