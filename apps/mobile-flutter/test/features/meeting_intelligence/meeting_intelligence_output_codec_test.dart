import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_output_codec.dart';

void main() {
  const codec = MeetingIntelligenceOutputCodec();

  test('valid v1 fixture maps every supported structured kind', () {
    final output = codec.decode(
      File(
        'test/fixtures/meeting_intelligence/valid_output_v1.json',
      ).readAsStringSync(),
    );

    expect(output.schemaVersion, MeetingIntelligenceOutputCodec.schemaVersion);
    expect(output.meetingType, 'weekly');
    expect(output.suggestedTitle, 'S3 交付周会');
    expect(
      output.items.map((item) => item.kind).toSet(),
      MeetingInsightKind.values.toSet(),
    );
    final action = output.items.singleWhere(
      (item) => item.kind == MeetingInsightKind.action,
    );
    expect(action.actionOwner, isNull);
    expect(action.actionDueAtMs, isNull);
    expect(action.resolutionState, MeetingInsightResolutionState.open);
  });

  test('rejects empty, malformed and unknown schema atomically', () {
    expect(() => codec.decode(''), throwsFormatException);
    expect(() => codec.decode('{not-json'), throwsFormatException);
    expect(
      () => codec.decode(
        File(
          'test/fixtures/meeting_intelligence/unknown_schema.json',
        ).readAsStringSync(),
      ),
      throwsFormatException,
    );
  });

  test('rejects unknown fields, invalid enums and oversized bodies', () {
    expect(
      () => codec.decode('''
{"schema_version":"meeting_intelligence_output/v1","items":[],"raw_response":"no"}
'''),
      throwsFormatException,
    );
    expect(
      () => codec.decode('''
{"schema_version":"meeting_intelligence_output/v1","items":[{"kind":"invented","body":"x","evidence":[]}]}
'''),
      throwsFormatException,
    );
    expect(
      () => codec.decode(
        '{"schema_version":"meeting_intelligence_output/v1","items":['
        '{"kind":"summary","body":"${'x' * 4001}","evidence":[]}]}',
      ),
      throwsFormatException,
    );
  });
}
