import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/contracts/audio_contract.dart';
import 'package:voice2text_flutter/features/transcription/service/realtime_transcription_event.dart';

void main() {
  test('parses segment payload', () {
    final RealtimeTranscriptionEvent event =
        RealtimeTranscriptionEvent.fromPayload(<Object?, Object?>{
          'type': AudioContract.eventTypeSegment,
          'recordingPath': '/tmp/a.wav',
          'sequenceId': 2,
          'text': '你好',
          'startMs': 100,
          'endMs': 900,
          'isFinal': true,
          'source': 'realtime',
        });

    expect(event.isSegment, isTrue);
    expect(event.sequenceId, 2);
    expect(event.text, '你好');
  });

  test('parses degradation payload as non fatal event', () {
    final RealtimeTranscriptionEvent event =
        RealtimeTranscriptionEvent.fromPayload(<Object?, Object?>{
          'type': AudioContract.eventTypeDegradation,
          'recordingPath': '/tmp/a.wav',
          'reason': '队列过长',
        });

    expect(event.isDegradation, isTrue);
    expect(event.reason, '队列过长');
  });

  test('malformed payload does not throw', () {
    final RealtimeTranscriptionEvent event =
        RealtimeTranscriptionEvent.malformed('bad');

    expect(event.type, RealtimeTranscriptionEventType.unknown);
    expect(event.reason, contains('String'));
  });
}
