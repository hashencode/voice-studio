import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/settings/model/transcription_model_descriptor.dart';

void main() {
  test('paraformer is the default selectable model', () {
    final TranscriptionModelDescriptor model =
        TranscriptionModelDescriptor.defaultModel();

    expect(model.id, 'paraformer-zh');
    expect(model.selectable, isTrue);
    expect(model.canTranscribeOffline, isTrue);
    expect(model.punctuationReady, isTrue);
  });

  test(
    'paraformer capability gates distinguish presence from verification',
    () {
      final TranscriptionModelDescriptor model =
          TranscriptionModelDescriptor.defaultModel();

      expect(model.itn.available, isFalse);
      expect(model.itn.verified, isFalse);
      expect(model.itn.reason, 'itn_asset_missing');

      expect(model.confidence.available, isFalse);
      expect(model.confidence.verified, isFalse);
      expect(model.confidence.reason, 'recognizer_confidence_unavailable');

      expect(model.hotwords.available, isFalse);
      expect(model.hotwords.verified, isFalse);
      expect(model.hotwords.reason, 'paraformer_hotwords_unsupported');

      expect(model.enhancement.available, isTrue);
      expect(model.enhancement.verified, isFalse);
      expect(model.enhancement.reason, 'enhancement_benchmark_pending');
      expect(model.denoiseReady, model.enhancement.verified);
    },
  );

  test('only the real offline model is exposed', () {
    expect(TranscriptionModelDescriptor.known, hasLength(1));
    expect(
      TranscriptionModelDescriptor.findById('sherpa-streaming-zh'),
      isNull,
    );
  });
}
