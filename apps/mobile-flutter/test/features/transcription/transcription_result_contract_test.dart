import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';

void main() {
  test('structured result round trips with ordered final segments', () {
    final result = TranscriptionResult(
      mergedText: '第一段 第二段',
      segments: const <TranscriptionSegmentResult>[
        TranscriptionSegmentResult(
          sequenceId: 0,
          text: '第一段',
          startMs: 100,
          endMs: 900,
          confidence: 0.8,
        ),
        TranscriptionSegmentResult(
          sequenceId: 1,
          text: '第二段',
          startMs: 1200,
          endMs: 2100,
        ),
      ],
    );

    final restored = TranscriptionResult.fromMap(result.toMap());

    expect(restored.mergedText, '第一段 第二段');
    expect(restored.segments, hasLength(2));
    expect(restored.segments.first.confidence, 0.8);
    expect(restored.segments.last.confidence, isNull);
    expect(restored.segments.last.startMs, 1200);
  });

  test('invalid, empty, overlapping, or non-final segments are rejected', () {
    expect(
      () => TranscriptionResult(
        mergedText: '',
        segments: const <TranscriptionSegmentResult>[],
      ),
      throwsFormatException,
    );
    expect(
      () => TranscriptionResult(
        mergedText: '一 二',
        segments: const <TranscriptionSegmentResult>[
          TranscriptionSegmentResult(
            sequenceId: 0,
            text: '一',
            startMs: 0,
            endMs: 1000,
          ),
          TranscriptionSegmentResult(
            sequenceId: 1,
            text: '二',
            startMs: 900,
            endMs: 1200,
          ),
        ],
      ),
      throwsFormatException,
    );
    expect(
      () => TranscriptionResult(
        mergedText: '未完成',
        segments: const <TranscriptionSegmentResult>[
          TranscriptionSegmentResult(
            sequenceId: 0,
            text: '未完成',
            startMs: 0,
            endMs: 1000,
            isFinal: false,
          ),
        ],
      ),
      throwsFormatException,
    );
  });

  test('merged text must equal final segment order', () {
    expect(
      () => TranscriptionResult(
        mergedText: '顺序错误',
        segments: const <TranscriptionSegmentResult>[
          TranscriptionSegmentResult(
            sequenceId: 0,
            text: '真实文本',
            startMs: 0,
            endMs: 1000,
          ),
        ],
      ),
      throwsFormatException,
    );
  });
}
