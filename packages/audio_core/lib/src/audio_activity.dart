final RegExp _audioIdPattern = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$');

/// Stable identity for an activity in the Audio product domain.
final class AudioId {
  AudioId(this.value) {
    if (!_audioIdPattern.hasMatch(value)) {
      throw const FormatException('Audio id is invalid.');
    }
  }

  final String value;

  @override
  bool operator ==(Object other) => other is AudioId && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}
