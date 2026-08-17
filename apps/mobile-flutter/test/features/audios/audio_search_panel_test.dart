import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/service/audio_search_service.dart';
import 'package:voice2text_flutter/features/audios/widgets/audio_search_panel.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  testWidgets(
    'accepts keyboard time input, reports range errors, and combines filters',
    (tester) async {
      AudioTranscriptQuery? query;
      var cleared = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AudioSearchPanel(
                durationMs: 10000,
                results: <TranscriptSegmentEntity>[
                  _segment(1, '命中一'),
                  _segment(2, '命中二'),
                ],
                onSearch: (value) => query = value,
                onClear: () => cleared = true,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );

      final fields = find.byType(EditableText);
      expect(fields, findsNWidgets(3));
      await tester.enterText(fields.at(1), '00:00:05');
      await tester.enterText(fields.at(2), '00:00:04');
      await tester.pump();
      expect(find.text('结束时间必须晚于开始时间'), findsOneWidget);

      await tester.enterText(fields.at(2), '00:00:08');
      await tester.tap(find.text('待复核'));
      await tester.pump();
      expect(query?.timeRange?.startMs, 5000);
      expect(query?.timeRange?.endMs, 8000);
      expect(query?.reviewState, TranscriptReviewState.needsReview);

      await tester.enterText(fields.first, '命中');
      await tester.pump(const Duration(milliseconds: 350));
      expect(query?.normalizedText, '命中');
      expect(find.text('2 个结果'), findsOneWidget);
      expect(find.text('时间 00:00:05–00:00:08'), findsOneWidget);
      expect(find.text('状态 待复核'), findsOneWidget);

      await tester.tap(find.text('清除筛选'));
      await tester.pump();
      expect(cleared, isTrue);
      expect(find.text('00:00:00'), findsOneWidget);
      expect(find.text('00:00:10'), findsOneWidget);
    },
  );

  testWidgets('supports hours over 23, screen reader order, and 200% text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              child: AudioSearchPanel(
                durationMs: const Duration(
                  hours: 25,
                  minutes: 3,
                ).inMilliseconds,
                results: const <TranscriptSegmentEntity>[],
                onSearch: (_) {},
                onClear: () {},
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('25:03:00'), findsOneWidget);
      final startTop = tester.getTopLeft(find.text('开始时间')).dy;
      final endTop = tester.getTopLeft(find.text('结束时间')).dy;
      expect(startTop, lessThan(endTop));
      expect(find.bySemanticsLabel('转写复核状态筛选'), findsOneWidget);
    } finally {
      semantics.dispose();
    }
  });
}

TranscriptSegmentEntity _segment(int id, String text) {
  return TranscriptSegmentEntity(
    id: id,
    recordingPath: '/search.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: id - 1,
    text: text,
    startMs: (id - 1) * 1000,
    endMs: id * 1000,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
