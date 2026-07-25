class MeetingTimeRange {
  MeetingTimeRange({
    required this.startMs,
    required this.endMs,
    required this.durationMs,
  }) {
    if (durationMs <= 0) {
      throw ArgumentError.value(durationMs, 'durationMs', '会议时长必须大于 0');
    }
    if (startMs < 0) {
      throw ArgumentError.value(startMs, 'startMs', '开始时间不能小于 0');
    }
    if (endMs <= startMs) {
      throw ArgumentError.value(endMs, 'endMs', '结束时间必须晚于开始时间');
    }
    if (endMs > durationMs) {
      throw ArgumentError.value(endMs, 'endMs', '结束时间不能超过会议时长');
    }
  }

  factory MeetingTimeRange.full(int durationMs) {
    return MeetingTimeRange(
      startMs: 0,
      endMs: durationMs,
      durationMs: durationMs,
    );
  }

  final int startMs;
  final int endMs;
  final int durationMs;

  bool intersects({required int startMs, required int endMs}) {
    if (startMs < 0 || endMs <= startMs) return false;
    return startMs < this.endMs && endMs > this.startMs;
  }

  Map<String, int> toJson() {
    return <String, int>{'startMs': startMs, 'endMs': endMs};
  }

  @override
  bool operator ==(Object other) {
    return other is MeetingTimeRange &&
        other.startMs == startMs &&
        other.endMs == endMs &&
        other.durationMs == durationMs;
  }

  @override
  int get hashCode => Object.hash(startMs, endMs, durationMs);
}
