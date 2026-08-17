import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/utils/meeting_time_text.dart';

void main() {
  test('parses and formats meeting clocks beyond 24 hours', () {
    expect(parseMeetingClock('25:01:02'), 90062000);
    expect(formatMeetingClock(90062000), '25:01:02');
  });

  test('rejects incomplete clocks and out-of-range minutes or seconds', () {
    expect(parseMeetingClock('1:02'), isNull);
    expect(parseMeetingClock('01:60:00'), isNull);
    expect(parseMeetingClock('01:00:60'), isNull);
  });
}
