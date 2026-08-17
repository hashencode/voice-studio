import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/widgets/audio_topic_timeline.dart';

void main() {
  testWidgets('orders topics by time and exposes seek selection', (
    tester,
  ) async {
    AudioInsightEntity? selected;
    final later = _topic(2, 'Later topic', 5000, 7000);
    final earlier = _topic(1, 'Earlier topic', 1000, 3000);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AudioTopicTimeline(
            topics: <AudioInsightEntity>[later, earlier],
            onSelected: (topic) => selected = topic,
          ),
        ),
      ),
    );

    expect(
      tester.getTopLeft(find.text('Earlier topic')).dy,
      lessThan(tester.getTopLeft(find.text('Later topic')).dy),
    );
    await tester.tap(find.text('Earlier topic'));
    expect(selected?.id, earlier.id);
  });
}

AudioInsightEntity _topic(int id, String body, int startMs, int endMs) {
  return AudioInsightEntity(
    id: id,
    noteId: 1,
    kind: AudioInsightKind.topic,
    body: body,
    actionOwner: null,
    actionDueAtMs: null,
    unresolvedOwner: false,
    unresolvedDueDate: false,
    status: AudioInsightStatus.draft,
    unsupported: false,
    topicStartMs: startMs,
    topicEndMs: endMs,
    createdAtMs: 1,
    updatedAtMs: 1,
    reviewedAtMs: null,
    rejectedAtMs: null,
    publishedAtMs: null,
  );
}
