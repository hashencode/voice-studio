import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_export_service.dart';
import 'package:voice2text_flutter/features/meetings/widgets/meeting_export_panel.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  testWidgets('selects VTT and a validated range with preview count', (
    tester,
  ) async {
    MeetingExportRequest? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showMeetingExportPanel(
                  context,
                  durationMs: 10000,
                  segments: <TranscriptSegmentEntity>[
                    _segment(0, 0, 1000),
                    _segment(1, 2000, 3000),
                    _segment(2, 8000, 9000),
                  ],
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('VTT'));
    await tester.tap(find.text('时间范围'));
    await tester.pump();
    final fields = find.byType(EditableText);
    expect(fields, findsNWidgets(2));
    await tester.enterText(fields.first, '00:00:01');
    await tester.enterText(fields.last, '00:00:04');
    await tester.pump();

    expect(find.text('将导出 1 个片段'), findsOneWidget);
    await tester.tap(find.text('导出所选内容'));
    await tester.pumpAndSettle();
    expect(result?.format, MeetingExportFormat.vtt);
    expect(result?.selection.range?.startMs, 1000);
    expect(result?.selection.range?.endMs, 4000);
  });

  testWidgets('invalid or empty range cannot close the panel at 200% text', (
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
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () {
                showMeetingExportPanel(
                  context,
                  durationMs: 10000,
                  segments: <TranscriptSegmentEntity>[_segment(0, 0, 1000)],
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('时间范围'));
    await tester.pump();
    final fields = find.byType(EditableText);
    await tester.enterText(fields.first, '00:00:02');
    await tester.enterText(fields.last, '00:00:03');
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('所选范围没有可导出的转写片段'), findsOneWidget);
    await tester.tap(find.text('导出所选内容'), warnIfMissed: false);
    await tester.pump();
    expect(find.text('导出转写'), findsOneWidget);
    expect(find.bySemanticsLabel('当前范围无法导出'), findsOneWidget);
  });
}

TranscriptSegmentEntity _segment(int sequence, int startMs, int endMs) {
  return TranscriptSegmentEntity(
    id: sequence + 1,
    recordingPath: '/panel.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: sequence,
    text: 'segment $sequence',
    startMs: startMs,
    endMs: endMs,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
