import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/model/meeting_time_range.dart';

void main() {
  group('MeetingTimeRange', () {
    test('accepts a valid half-open range and exposes JSON metadata', () {
      final range = MeetingTimeRange(
        startMs: 1000,
        endMs: 3000,
        durationMs: 5000,
      );

      expect(range.toJson(), <String, int>{'startMs': 1000, 'endMs': 3000});
      expect(range.intersects(startMs: 0, endMs: 1000), isFalse);
      expect(range.intersects(startMs: 999, endMs: 1001), isTrue);
      expect(range.intersects(startMs: 2999, endMs: 4000), isTrue);
      expect(range.intersects(startMs: 3000, endMs: 4000), isFalse);
    });

    test('full range covers the complete positive meeting duration', () {
      expect(
        MeetingTimeRange.full(5000),
        MeetingTimeRange(startMs: 0, endMs: 5000, durationMs: 5000),
      );
    });

    test('rejects invalid meeting and boundary values', () {
      expect(() => MeetingTimeRange.full(0), throwsArgumentError);
      expect(
        () => MeetingTimeRange(startMs: -1, endMs: 1, durationMs: 5),
        throwsArgumentError,
      );
      expect(
        () => MeetingTimeRange(startMs: 1, endMs: 1, durationMs: 5),
        throwsArgumentError,
      );
      expect(
        () => MeetingTimeRange(startMs: 1, endMs: 6, durationMs: 5),
        throwsArgumentError,
      );
    });

    test('rejects malformed segment intervals during intersection', () {
      final range = MeetingTimeRange.full(5000);

      expect(range.intersects(startMs: -1, endMs: 100), isFalse);
      expect(range.intersects(startMs: 100, endMs: 100), isFalse);
    });
  });
}
