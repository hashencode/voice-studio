import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';

void main() {
  test('defaults keep standard mode enabled', () {
    final AppSettings settings = AppSettings.defaults();

    expect(settings.modelId, 'paraformer-zh');
    expect(settings.recordingMode, RecordingMode.standard);
    expect(settings.autoTranscribe, isTrue);
  });

  test('unknown recording mode falls back to standard', () {
    expect(RecordingMode.fromStorage('missing'), RecordingMode.standard);
    expect(RecordingMode.fromStorage(null), RecordingMode.standard);
  });
}
