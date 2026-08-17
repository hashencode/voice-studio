import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'Android exposes input discovery and active selection over the bridge',
    () {
      final activity = File(
        'android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt',
      ).readAsStringSync();
      final session = File(
        'android/app/src/main/kotlin/com/voice2text/app/recording/'
        'StandardRecordingSession.kt',
      ).readAsStringSync();

      expect(activity, contains('"listRecordingInputDevices"'));
      expect(activity, contains('"selectRecordingInputDevice"'));
      expect(session, contains('setPreferredDevice'));
      expect(session, contains('Build.VERSION_CODES.M'));
      expect(session, contains('return routedDevice'));
    },
  );

  test('selected-device disconnect has explicit fallback and stop paths', () {
    final service = File(
      'android/app/src/main/kotlin/com/voice2text/app/recording/'
      'RecordingForegroundService.kt',
    ).readAsStringSync();

    expect(service, contains('registerAudioDeviceCallback'));
    expect(service, contains('handleInputDevicesRemoved'));
    expect(service, contains('"input_device_lost"'));
  });
}
