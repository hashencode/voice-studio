import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android discovery accepts only the Audio v2 capability', () {
    final source = File(
      'android/app/src/main/kotlin/com/voice2text/app/companion/'
      'CompanionPlatformPlugin.kt',
    ).readAsStringSync();

    expect(source, contains('capability != "audio-transfer/v2"'));
    expect(source, isNot(contains('capability != "media-transfer/v1"')));
    expect(source, contains('SERVICE_TYPE = "_voice2text-audio._tcp."'));
    expect(source, isNot(contains('_voice2text-media._tcp.')));
  });
}
