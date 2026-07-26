import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../model/meeting_insight_entity.dart';

class MeetingTopicTimeline extends StatelessWidget {
  const MeetingTopicTimeline({
    super.key,
    required this.topics,
    required this.onSelected,
  });

  final List<MeetingInsightEntity> topics;
  final ValueChanged<MeetingInsightEntity> onSelected;

  @override
  Widget build(BuildContext context) {
    final ordered =
        topics
            .where(
              (topic) =>
                  topic.kind == MeetingInsightKind.topic &&
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
