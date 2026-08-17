String formatDurationMs(int ms) {
  final int totalSeconds = (ms / 1000).floor();
  final int minutes = totalSeconds ~/ 60;
  final int seconds = totalSeconds % 60;
  final String mm = minutes.toString().padLeft(2, '0');
  final String ss = seconds.toString().padLeft(2, '0');
  return '$mm:$ss';
}
