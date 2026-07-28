import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/platform/macos_runtime_capabilities.dart';

void main() {
  test('parses the macOS platform version format', () {
    expect(
      MacosVersion.parse('Version 15.7.5 (Build 24G624)').toString(),
      '15.7.5',
    );
    expect(MacosVersion.parse('macOS 14.2').toString(), '14.2');
  });

  test('gates capabilities at their actual native minimums', () {
    const macos13 = MacosRuntimeCapabilities(MacosVersion(13, 6));
    const macos14 = MacosRuntimeCapabilities(MacosVersion(14, 2));
    const macos15 = MacosRuntimeCapabilities(MacosVersion(15, 5));

    expect(macos13.supportsMicrophoneCapture, isTrue);
    expect(macos13.supportsSystemAudioCapture, isFalse);
    expect(macos13.supportsLocalProcessing, isFalse);
    expect(macos14.supportsSystemAudioCapture, isTrue);
    expect(macos14.supportsMicrophoneCapture, isTrue);
    expect(macos14.supportsLocalProcessing, isFalse);
    expect(macos15.supportsSystemAudioCapture, isTrue);
    expect(macos15.supportsMicrophoneCapture, isTrue);
    expect(macos15.supportsLocalProcessing, isTrue);
  });
}
