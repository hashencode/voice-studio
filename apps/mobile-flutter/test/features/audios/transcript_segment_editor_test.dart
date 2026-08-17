import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/widgets/transcript_segment_editor.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  testWidgets(
    'editor saves nonempty text and keeps time bounds informational',
    (tester) async {
      TranscriptSegmentEditResult? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              return Scaffold(
                body: TextButton(
                  onPressed: () async {
                    result = await showTranscriptSegmentEditor(
                      context: context,
                      segment: _segment(),
                    );
                  },
                  child: const Text('edit'),
                ),
              );
            },
          ),
        ),
      );

      await tester.tap(find.text('edit'));
      await tester.pumpAndSettle();
      expect(find.textContaining('00:01 – 00:04'), findsOneWidget);
      final editable = find.byType(EditableText);
      expect(editable, findsOneWidget);
      await tester.enterText(editable, 'Revised multiline\ncontent');
      await tester.tap(find.bySemanticsLabel('保存时标为已复核'));
      await tester.pump();
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(result?.text, 'Revised multiline\ncontent');
      expect(result?.markReviewed, isTrue);
    },
  );
}

TranscriptSegmentEntity _segment() {
  return TranscriptSegmentEntity(
    id: 1,
    recordingPath: '/audio.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: 0,
    text: 'Original',
    startMs: 1000,
    endMs: 4000,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
