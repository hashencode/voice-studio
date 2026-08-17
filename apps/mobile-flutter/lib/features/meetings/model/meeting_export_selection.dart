import 'meeting_time_range.dart';

class MeetingExportSelection {
  const MeetingExportSelection.all() : range = null;

  const MeetingExportSelection.range(MeetingTimeRange this.range);

  final MeetingTimeRange? range;

  bool get isAll => range == null;

  bool intersects({required int startMs, required int endMs}) {
    return range?.intersects(startMs: startMs, endMs: endMs) ?? true;
  }
}
