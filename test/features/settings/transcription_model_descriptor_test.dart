import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/settings/model/transcription_model_descriptor.dart';

void main() {
  test('paraformer is the default selectable model', () {
    final TranscriptionModelDescriptor model =
        TranscriptionModelDescriptor.defaultModel();

    expect(model.id, 'paraformer-zh');
    expect(model.selectable, isTrue);
    expect(model.canTranscribeOffline, isTrue);
  });

  test('streaming placeholder is not selectable', () {
    final TranscriptionModelDescriptor? model =
        TranscriptionModelDescriptor.findById('sherpa-streaming-zh');

    expect(model, isNotNull);
    expect(model!.selectable, isFalse);
  });
}
