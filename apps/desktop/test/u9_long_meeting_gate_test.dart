import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/u9_long_meeting_gate.dart';

void main() {
  final enabled = Platform.environment['RUN_U9_LONG_MEETING'] == '1';
  test(
    'frozen product engine finishes full two-hour ASR and diarization under 30m',
    () async {
      final evidence = await runU9LongMeetingGate();
      stdout.writeln('U9_LONG_MEETING_EVIDENCE=${jsonEncode(evidence)}');
      expect(evidence['status'], 'PASS');
      expect(evidence['diarizationSucceeded'], isTrue);
      expect(evidence['segmentCount'], isNonZero);
      expect(evidence['elapsedMilliseconds']! as int, lessThan(30 * 60 * 1000));
    },
    skip: enabled
        ? false
        : 'set RUN_U9_LONG_MEETING=1 for the two-hour target-host gate',
    timeout: const Timeout(Duration(minutes: 40)),
  );
}
