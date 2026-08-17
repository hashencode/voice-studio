import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_template.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_validator.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test('processing location maps legacy storage values', () {
    expect(
      MeetingProcessingLocation.fromStorage('local'),
      MeetingProcessingLocation.onDevice,
    );
    expect(
      MeetingProcessingLocation.fromStorage('remote'),
      MeetingProcessingLocation.cloudDirect,
    );
    expect(
      MeetingProcessingLocation.fromStorage('pairedPc'),
      MeetingProcessingLocation.pairedPc,
    );
    expect(
      MeetingProcessingLocation.fromStorage('unknown'),
      MeetingProcessingLocation.onDevice,
    );
  });

  test('all product templates have stable unique identifiers', () {
    expect(MeetingTemplate.known, hasLength(7));
    expect(
      MeetingTemplate.known.map((template) => template.id).toSet(),
      hasLength(7),
    );
    expect(MeetingTemplate.find(MeetingTemplateId.retrospective).label, '复盘');
  });

  test('validator carries S3 metadata and validates topic range', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureMeetingIntelligenceProvider(
      output: MeetingIntelligenceOutput(
        meetingType: '评审',
        suggestedTitle: 'S3 review',
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.topic,
            body: 'Product scope',
            topicStartMs: 1000,
            topicEndMs: 4000,
            sortOrder: 3,
            evidence: <MeetingEvidenceCandidate>[
              MeetingEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1000,
                endMs: 4000,
              ),
            ],
          ),
        ],
      ),
    );

    final validated = const MeetingIntelligenceValidator().validate(
      request: fixture.request,
      output: provider.output,
    );
    expect(validated.schemaVersion, 'meeting_intelligence_output/v1');
    expect(validated.meetingType, '评审');
    expect(validated.suggestedTitle, 'S3 review');
    expect(validated.items.single.candidate.sortOrder, 3);
  });

  test('validator rejects unknown output schema', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);

    expect(
      () => const MeetingIntelligenceValidator().validate(
        request: fixture.request,
        output: const MeetingIntelligenceOutput(
          schemaVersion: 'meeting_intelligence_output/v2',
          items: <MeetingInsightCandidate>[],
        ),
      ),
      throwsFormatException,
    );
  });
}
