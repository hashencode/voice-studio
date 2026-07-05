import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/model/live_transcript_state.dart';
import 'package:voice2text_flutter/features/transcription/service/realtime_transcription_event.dart';

void main() {
  test('orders out-of-order realtime segments by sequence id', () {
    final LiveTranscriptState state = LiveTranscriptState.empty()
        .apply(
          RealtimeTranscriptionEvent.segment(
            recordingPath: '/tmp/a.wav',
            sequenceId: 2,
            text: '第二段',
            startMs: 1000,
            endMs: 2000,
          ),
        )
        .apply(
          RealtimeTranscriptionEvent.segment(
            recordingPath: '/tmp/a.wav',
            sequenceId: 1,
            text: '第一段',
            startMs: 0,
            endMs: 900,
          ),
        );

    expect(state.mergedText, '第一段\n第二段');
  });

  test('replaces duplicate sequence instead of appending', () {
    final LiveTranscriptState state = LiveTranscriptState.empty()
        .apply(
          RealtimeTranscriptionEvent.segment(
            recordingPath: '/tmp/a.wav',
            sequenceId: 1,
            text: '旧文本',
            startMs: 0,
            endMs: 900,
          ),
        )
        .apply(
          RealtimeTranscriptionEvent.segment(
            recordingPath: '/tmp/a.wav',
            sequenceId: 1,
            text: '新文本',
            startMs: 0,
            endMs: 900,
          ),
        );

    expect(state.orderedSegments, hasLength(1));
    expect(state.mergedText, '新文本');
  });
}
