import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';

void main() {
  test('defaults keep automatic transcription enabled', () {
    final AppSettings settings = AppSettings.defaults();

    expect(settings.modelId, 'paraformer-zh');
    expect(settings.autoTranscribe, isTrue);
  });
}
