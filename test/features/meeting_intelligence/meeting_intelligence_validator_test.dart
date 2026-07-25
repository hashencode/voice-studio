import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_validator.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test('validates supported decision with multiple evidence links', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validator = const MeetingIntelligenceValidator();
    final validated = validator.validate(
      request: fixture.request,
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.decision,
            body: 'Ship the release.',
            evidence: <MeetingEvidenceCandidate>[
              MeetingEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1100,
                endMs: 2000,
              ),
              MeetingEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 2200,
                endMs: 3500,
              ),
            ],
          ),
        ],
      ),
    );
    expect(validated.items.single.unsupported, isFalse);
  });

  test('zero evidence is retained but visibly unsupported', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validated = const MeetingIntelligenceValidator().validate(
      request: fixture.request,
      output: const MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.summary,
            body: 'Unsupported draft.',
          ),
        ],
      ),
    );
    expect(validated.items.single.unsupported, isTrue);
  });

  test('action keeps missing owner and due date unresolved', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validated = const MeetingIntelligenceValidator().validate(
      request: fixture.request,
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.action,
            body: 'Prepare rollout.',
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
    expect(validated.items.single.unresolvedOwner, isTrue);
    expect(validated.items.single.unresolvedDueDate, isTrue);
  });

  test('rejects nonexistent and out-of-range evidence', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    const validator = MeetingIntelligenceValidator();
    expect(
      () => validator.validate(
        request: fixture.request,
        output: const MeetingIntelligenceOutput(
          items: <MeetingInsightCandidate>[
            MeetingInsightCandidate(
              kind: MeetingInsightKind.risk,
              body: 'Risk.',
              evidence: <MeetingEvidenceCandidate>[
                MeetingEvidenceCandidate(segmentId: 9999, startMs: 1, endMs: 2),
              ],
            ),
          ],
        ),
      ),
      throwsFormatException,
    );
    expect(
      () => validator.validate(
        request: fixture.request,
        output: MeetingIntelligenceOutput(
          items: <MeetingInsightCandidate>[
            MeetingInsightCandidate(
              kind: MeetingInsightKind.risk,
              body: 'Risk.',
              evidence: <MeetingEvidenceCandidate>[
                MeetingEvidenceCandidate(
                  segmentId: fixture.segment.id,
                  startMs: 500,
                  endMs: 4500,
                ),
              ],
            ),
          ],
        ),
      ),
      throwsFormatException,
    );
  });
}
