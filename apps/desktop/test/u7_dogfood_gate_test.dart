import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/u7_dogfood_gate.dart';

void main() {
  final enabled = Platform.environment['RUN_U7_DOGFOOD'] == '1';
  test(
    'five pinned real-source meetings complete review and export dogfood',
    () async {
      final evidence = await runU7DogfoodGate();
      stdout.writeln('U7_DOGFOOD_EVIDENCE=${jsonEncode(evidence)}');
      expect(evidence['meetingCount'], 5);
      expect(evidence['speakerAssignmentsReviewed'], isNonZero);
      expect(evidence['records'], hasLength(5));
      expect(
        evidence['aggregateSpeakerCorrectionRate']! as double,
        lessThanOrEqualTo(0.10),
      );
      expect(evidence['recoveryStateUnderstanding'], startsWith('PASS_'));
      expect(evidence['continuedUseWillingness'], startsWith('PASS_'));
    },
    skip: enabled ? false : 'set RUN_U7_DOGFOOD=1 for the real dogfood gate',
    timeout: const Timeout(Duration(minutes: 20)),
  );
}
