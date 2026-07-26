import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/u7_real_fixture_smoke.dart';

void main() {
  final enabled = Platform.environment['RUN_U7_REAL_FIXTURE'] == '1';
  test(
    'built macOS worker processes the pinned real meeting fixture end to end',
    () async {
      final evidence = await runU7RealFixtureSmoke();
      // A stable marker makes the reviewed run easy to capture in gate evidence.
      stdout.writeln(
        'U7_REAL_FIXTURE_EVIDENCE='
        '${jsonEncode(evidence)}',
      );
      expect(evidence['builtAppCodesignVerified'], isTrue);
      expect(evidence['jobState'], 'completed');
      expect(evidence['segmentCount'], isNonZero);
      expect(evidence['reviewEditUndoRedoPreserved'], isTrue);
      expect(evidence['searchMatches'], isNonZero);
    },
    skip: enabled ? false : 'set RUN_U7_REAL_FIXTURE=1 for the networked gate',
    timeout: const Timeout(Duration(minutes: 20)),
  );
}
