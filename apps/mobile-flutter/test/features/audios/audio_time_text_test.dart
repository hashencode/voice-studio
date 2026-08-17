import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/utils/audio_time_text.dart';

void main() {
  test('parses and formats audio clocks beyond 24 hours', () {
    expect(parseAudioClock('25:01:02'), 90062000);
    expect(formatAudioClock(90062000), '25:01:02');
  });

  test('rejects incomplete clocks and out-of-range minutes or seconds', () {
    expect(parseAudioClock('1:02'), isNull);
    expect(parseAudioClock('01:60:00'), isNull);
    expect(parseAudioClock('01:00:60'), isNull);
  });
}
