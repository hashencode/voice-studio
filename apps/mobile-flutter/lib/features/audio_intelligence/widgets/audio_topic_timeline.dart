import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../model/audio_insight_entity.dart';

class AudioTopicTimeline extends StatelessWidget {
  const AudioTopicTimeline({
    super.key,
    required this.topics,
    required this.onSelected,
  });

  final List<AudioInsightEntity> topics;
  final ValueChanged<AudioInsightEntity> onSelected;

  @override
  Widget build(BuildContext context) {
    final ordered =
        topics
            .where(
              (topic) =>
                  topic.kind == AudioInsightKind.topic &&
                  topic.topicStartMs != null &&
                  topic.topicEndMs != null,
            )
            .toList(growable: false)
          ..sort(
            (left, right) => left.topicStartMs!.compareTo(right.topicStartMs!),
          );
    if (ordered.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const GooText('议题时间线', variant: GooTextVariant.subtitle),
        const SizedBox(height: 8),
        GooList(
          children: ordered
              .map(
                (topic) => GooListItem(
                  title: topic.body,
                  subtitle:
                      '${_clock(topic.topicStartMs!)} – ${_clock(topic.topicEndMs!)}',
                  showGuide: true,
                  onTap: () => onSelected(topic),
                ),
              )
              .toList(growable: false),
        ),
      ],
    );
  }
}

String _clock(int milliseconds) {
  final duration = Duration(milliseconds: milliseconds);
  return '${duration.inMinutes.toString().padLeft(2, '0')}:'
      '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}';
}
