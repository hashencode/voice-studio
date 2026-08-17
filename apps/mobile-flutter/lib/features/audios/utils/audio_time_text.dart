final RegExp _audioClockPattern = RegExp(r'^(\d+):([0-5]\d):([0-5]\d)$');

int? parseAudioClock(String value) {
  final match = _audioClockPattern.firstMatch(value.trim());
  if (match == null) return null;
  return Duration(
    hours: int.parse(match.group(1)!),
    minutes: int.parse(match.group(2)!),
    seconds: int.parse(match.group(3)!),
  ).inMilliseconds;
}

String formatAudioClock(int milliseconds) {
  final totalSeconds = milliseconds ~/ 1000;
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds ~/ 60).remainder(60);
  final seconds = totalSeconds.remainder(60);
  return '${hours.toString().padLeft(2, '0')}:'
      '${minutes.toString().padLeft(2, '0')}:'
      '${seconds.toString().padLeft(2, '0')}';
}
