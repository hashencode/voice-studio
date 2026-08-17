import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/service/android_transcription_service.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_port.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const MethodChannel channel = MethodChannel('voice2text/recorder');

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'Android request exposes only the real offline runtime contract',
    () async {
      MethodCall? captured;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (MethodCall call) async {
            captured = call;
            return <String, Object?>{
              'mergedText': '音频转写',
              'segments': <Map<String, Object?>>[
                <String, Object?>{
                  'sequenceId': 0,
                  'text': '音频转写',
                  'startMs': 0,
                  'endMs': 1200,
                  'isFinal': true,
                  'source': 'standard_offline',
                  'confidence': null,
                },
              ],
            };
          });

      final TranscriptionResult result = await AndroidTranscriptionService()
          .transcribe(
            TranscriptionRequest(
              recordingPath: '/private/audio.m4a',
              durationMs: 1200,
              modelId: 'paraformer-zh',
              attemptCount: 3,
            ),
            jobId: 41,
          );

      expect(result.mergedText, '音频转写');
      expect(result.segments, hasLength(1));
      expect(result.segments.single.confidence, isNull);
      expect(captured?.method, 'transcribe');
      expect(
        (captured?.arguments as Map<Object?, Object?>).keys,
        unorderedEquals(<String>[
          'jobId',
          'recordingPath',
          'durationMs',
          'modelId',
          'sampleRateHz',
          'enablePunctuation',
          'enableDenoise',
          'attemptCount',
        ]),
      );
      expect(captured?.arguments, containsPair('attemptCount', 3));
      expect(captured?.arguments, containsPair('jobId', 41));
      expect(captured?.arguments, containsPair('enableDenoise', false));
      expect(
        (captured?.arguments as Map<Object?, Object?>),
        isNot(contains('engineMode')),
      );
      expect(
        (captured?.arguments as Map<Object?, Object?>),
        isNot(contains('hotwords')),
      );
      expect(
        (captured?.arguments as Map<Object?, Object?>),
        isNot(contains('terminology')),
      );
    },
  );
}
