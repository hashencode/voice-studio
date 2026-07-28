import 'dart:io';

const MacosVersion macosApplicationMinimumVersion = MacosVersion(13, 0);
const MacosVersion macosLocalProcessingMinimumVersion = MacosVersion(15, 5);
const MacosVersion macosSystemAudioCaptureMinimumVersion = MacosVersion(14, 2);

class MacosVersion implements Comparable<MacosVersion> {
  const MacosVersion(this.major, this.minor, [this.patch = 0]);

  factory MacosVersion.parse(String source) {
    final match = RegExp(r'(\d+)\.(\d+)(?:\.(\d+))?').firstMatch(source);
    if (match == null) {
      throw FormatException('Cannot parse macOS version: $source');
    }
    return MacosVersion(
      int.parse(match.group(1)!),
      int.parse(match.group(2)!),
      int.tryParse(match.group(3) ?? '') ?? 0,
    );
  }

  final int major;
  final int minor;
  final int patch;

  @override
  int compareTo(MacosVersion other) {
    final majorOrder = major.compareTo(other.major);
    if (majorOrder != 0) return majorOrder;
    final minorOrder = minor.compareTo(other.minor);
    return minorOrder != 0 ? minorOrder : patch.compareTo(other.patch);
  }

  bool isAtLeast(MacosVersion minimum) => compareTo(minimum) >= 0;

  @override
  String toString() => patch == 0 ? '$major.$minor' : '$major.$minor.$patch';
}

class MacosRuntimeCapabilities {
  const MacosRuntimeCapabilities(this.version);

  factory MacosRuntimeCapabilities.current() {
    return MacosRuntimeCapabilities(
      MacosVersion.parse(Platform.operatingSystemVersion),
    );
  }

  final MacosVersion version;

  bool get supportsMicrophoneCapture =>
      version.isAtLeast(macosApplicationMinimumVersion);

  bool get supportsSystemAudioCapture =>
      version.isAtLeast(macosSystemAudioCaptureMinimumVersion);

  bool get supportsLocalProcessing =>
      version.isAtLeast(macosLocalProcessingMinimumVersion);
}
