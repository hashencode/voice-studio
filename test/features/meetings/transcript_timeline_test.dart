import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/widgets/transcript_timeline.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  testWidgets('renders lazily, highlights current and seeks on tap', (
    tester,
  ) async {
    final segments = List<TranscriptSegmentEntity>.generate(
      3000,
      (index) => _segment(index),
    );
    TranscriptSegmentEntity? selected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 400,
            child: TranscriptTimeline(
              segments: segments,
              currentIndex: 0,
              onSeek: (value) => selected = value,
              onEdit: (_) {},
              onReviewStateChanged: (_, _) {},
            ),
          ),
        ),
      ),
    );

    expect(find.text('segment 0'), findsOneWidget);
    expect(find.text('segment 2999'), findsNothing);
    await tester.tap(find.text('segment 0'));
    expect(selected?.sequenceId, 0);
    final semantics = tester.getSemantics(find.byKey(const ValueKey<int>(1)));
    expect(semantics.label, contains('当前片段'));
    expect(semantics.label, contains('置信度未知'));
    expect(semantics.label, contains('未复核'));
    expect(tester.widget<ListView>(find.byType(ListView)).itemExtent, isNull);
  });

  testWidgets('shows empty result when transcript is unavailable', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TranscriptTimeline(
            segments: const <TranscriptSegmentEntity>[],
            currentIndex: null,
            onSeek: (_) {},
            onEdit: (_) {},
            onReviewStateChanged: (_, _) {},
          ),
        ),
      ),
    );
    expect(find.text('暂无会议时间线'), findsOneWidget);
  });

  testWidgets(
    'shows textual review state and exposes review actions through Goo menu',
    (tester) async {
      TranscriptReviewState? selectedState;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              height: 400,
              child: TranscriptTimeline(
                segments: <TranscriptSegmentEntity>[
                  _segment(0, reviewState: TranscriptReviewState.needsReview),
                ],
                currentIndex: null,
                onSeek: (_) {},
                onEdit: (_) {},
                onReviewStateChanged: (_, state) => selectedState = state,
              ),
            ),
          ),
        ),
      );

      expect(find.textContaining('待复核'), findsOneWidget);
      expect(find.textContaining('置信度未知'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('管理片段 1'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('标为已复核'));
      await tester.pumpAndSettle();
      expect(selectedState, TranscriptReviewState.reviewed);
    },
  );

  testWidgets('adds a semantic paragraph gap at 1500 ms but not 1499 ms', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TranscriptTimeline(
              segments: <TranscriptSegmentEntity>[
                _segment(0, startMs: 0, endMs: 1000),
                _segment(1, startMs: 2499, endMs: 2500),
                _segment(2, startMs: 4000, endMs: 4500),
              ],
              currentIndex: null,
              onSeek: (_) {},
              onEdit: (_) {},
              onReviewStateChanged: (_, _) {},
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('paragraph_gap_2')), findsNothing);
      expect(find.byKey(const Key('paragraph_gap_3')), findsOneWidget);
      expect(find.bySemanticsLabel('段落分隔，静音 1.5 秒'), findsOneWidget);
    } finally {
      semantics.dispose();
    }
  });

  testWidgets('supports 200 percent text without fixed-height overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: TranscriptTimeline(
            segments: <TranscriptSegmentEntity>[
              _segment(0, text: '这是一段用于验证百分之二百字体仍然可以完整换行显示的较长会议转写文本'),
            ],
            currentIndex: null,
            onSeek: (_) {},
            onEdit: (_) {},
            onReviewStateChanged: (_, _) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.textContaining('百分之二百字体'), findsOneWidget);
  });
}

TranscriptSegmentEntity _segment(
  int sequence, {
  String? text,
  int? startMs,
  int? endMs,
  TranscriptReviewState reviewState = TranscriptReviewState.unreviewed,
}) {
  return TranscriptSegmentEntity(
    id: sequence + 1,
    recordingPath: '/test.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: sequence,
    text: text ?? 'segment $sequence',
    startMs: startMs ?? sequence * 1000,
    endMs: endMs ?? sequence * 1000 + 900,
    isFinal: true,
    source: 'test',
    confidence: null,
    reviewState: reviewState,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
