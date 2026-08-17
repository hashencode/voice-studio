import 'audio_time_range.dart';

class AudioExportSelection {
  const AudioExportSelection.all() : range = null;

  const AudioExportSelection.range(AudioTimeRange this.range);

  final AudioTimeRange? range;

  bool get isAll => range == null;

  bool intersects({required int startMs, required int endMs}) {
    return range?.intersects(startMs: startMs, endMs: endMs) ?? true;
  }
}
