import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/shared/utils/formatters.dart';

void main() {
  test('formatDurationMs formats as mm:ss', () {
    expect(formatDurationMs(0), '00:00');
    expect(formatDurationMs(1000), '00:01');
    expect(formatDurationMs(61 * 1000), '01:01');
  });
}
