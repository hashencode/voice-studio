import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/model/audio_export_selection.dart';
import 'package:voice2text_flutter/features/audios/model/audio_time_range.dart';

void main() {
  test('all selection accepts every valid segment interval', () {
    const selection = AudioExportSelection.all();

    expect(selection.isAll, isTrue);
    expect(selection.intersects(startMs: 0, endMs: 1), isTrue);
  });

  test('range selection delegates to half-open intersection rules', () {
    final selection = AudioExportSelection.range(
      AudioTimeRange(startMs: 1000, endMs: 2000, durationMs: 5000),
    );

    expect(selection.isAll, isFalse);
    expect(selection.intersects(startMs: 0, endMs: 1000), isFalse);
    expect(selection.intersects(startMs: 999, endMs: 1001), isTrue);
    expect(selection.intersects(startMs: 2000, endMs: 3000), isFalse);
  });
}
