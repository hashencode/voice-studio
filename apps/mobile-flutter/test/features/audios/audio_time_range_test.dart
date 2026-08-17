import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/model/audio_time_range.dart';

void main() {
  group('AudioTimeRange', () {
    test('accepts a valid half-open range and exposes JSON metadata', () {
      final range = AudioTimeRange(
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

    test('full range covers the complete positive audio duration', () {
      expect(
        AudioTimeRange.full(5000),
        AudioTimeRange(startMs: 0, endMs: 5000, durationMs: 5000),
      );
    });

    test('rejects invalid audio and boundary values', () {
      expect(() => AudioTimeRange.full(0), throwsArgumentError);
      expect(
        () => AudioTimeRange(startMs: -1, endMs: 1, durationMs: 5),
        throwsArgumentError,
      );
      expect(
        () => AudioTimeRange(startMs: 1, endMs: 1, durationMs: 5),
        throwsArgumentError,
      );
      expect(
        () => AudioTimeRange(startMs: 1, endMs: 6, durationMs: 5),
        throwsArgumentError,
      );
    });

    test('rejects malformed segment intervals during intersection', () {
      final range = AudioTimeRange.full(5000);

      expect(range.intersects(startMs: -1, endMs: 100), isFalse);
      expect(range.intersects(startMs: 100, endMs: 100), isFalse);
    });
  });
}
