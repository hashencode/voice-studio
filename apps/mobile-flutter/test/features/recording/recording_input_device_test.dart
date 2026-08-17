import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';

void main() {
  test('recording input device parses the native selection contract', () {
    final device = RecordingInputDevice.fromMap(<Object?, Object?>{
      'id': 42,
      'name': '音频耳机',
      'inputDeviceType': 'bluetooth',
      'canSelect': true,
    });

    expect(device.id, 42);
    expect(device.name, '音频耳机');
    expect(device.type, RecordingInputDeviceType.bluetooth);
    expect(device.canSelect, isTrue);
  });

  test('recording snapshot exposes actual route and disconnect fallback', () {
    final snapshot = RecordingSessionSnapshot.fromMap(<Object?, Object?>{
      'sessionId': 'session-1',
      'state': 'recording',
      'durationMs': 1000,
      'inputDeviceId': 7,
      'inputDeviceName': 'USB Audio',
      'inputDeviceType': 'usb',
      'preferredInputDeviceId': null,
      'inputFallbackReason': 'device_disconnected',
      'inputSelectionSupported': true,
    });

    expect(snapshot.inputDeviceId, 7);
    expect(snapshot.inputDeviceName, 'USB Audio');
    expect(snapshot.preferredInputDeviceId, isNull);
    expect(
      snapshot.inputFallbackReason,
      RecordingInputFallbackReason.deviceDisconnected,
    );
    expect(snapshot.inputSelectionSupported, isTrue);
  });
}
