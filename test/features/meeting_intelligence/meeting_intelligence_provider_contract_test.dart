import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test('no configured provider fails without invoking anything', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    expect(
      () =>
          const MeetingIntelligenceProviderBoundary().generate(fixture.request),
      throwsStateError,
    );
  });

  test('provider is not invoked without explicit consent', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureMeetingIntelligenceProvider(
      output: const MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[],
      ),
    );
    final denied = MeetingIntelligenceRequest(
      recordingId: fixture.request.recordingId,
      generationId: fixture.request.generationId,
      processingLocation: MeetingProcessingLocation.local,
      consentDecision: MeetingConsentDecision.denied,
      inputStartMs: 0,
      inputEndMs: 10000,
      segments: fixture.request.segments,
    );
    expect(
      () => MeetingIntelligenceProviderBoundary(
        provider: provider,
      ).generate(denied),
      throwsStateError,
    );
    expect(provider.invocationCount, 0);
  });

  test('local-only boundary blocks remote processing', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureMeetingIntelligenceProvider(
      output: const MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.summary,
            body: 'fixture',
          ),
        ],
      ),
    );
    final remote = MeetingIntelligenceRequest(
      recordingId: fixture.request.recordingId,
      generationId: fixture.request.generationId,
      processingLocation: MeetingProcessingLocation.remote,
      consentDecision: MeetingConsentDecision.granted,
      inputStartMs: 0,
      inputEndMs: 10000,
      segments: fixture.request.segments,
    );
    expect(
      () => MeetingIntelligenceProviderBoundary(
        provider: provider,
        localOnly: true,
      ).generate(remote),
      throwsStateError,
    );
    expect(provider.invocationCount, 0);
  });
}
