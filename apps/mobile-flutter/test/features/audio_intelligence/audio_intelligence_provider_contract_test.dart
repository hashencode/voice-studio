import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test('no configured provider fails without invoking anything', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    expect(
      () => const AudioIntelligenceProviderBoundary().generate(fixture.request),
      throwsStateError,
    );
  });

  test('provider is not invoked without explicit consent', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureAudioIntelligenceProvider(
      output: const AudioIntelligenceOutput(items: <AudioInsightCandidate>[]),
    );
    final denied = AudioIntelligenceRequest(
      recordingId: fixture.request.recordingId,
      generationId: fixture.request.generationId,
      processingLocation: AudioProcessingLocation.onDevice,
      consentDecision: AudioConsentDecision.denied,
      inputStartMs: 0,
      inputEndMs: 10000,
      segments: fixture.request.segments,
    );
    expect(
      () => AudioIntelligenceProviderBoundary(
        provider: provider,
      ).generate(denied),
      throwsStateError,
    );
    expect(provider.invocationCount, 0);
  });

  test('local-only boundary blocks remote processing', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureAudioIntelligenceProvider(
      output: const AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.summary,
            body: 'fixture',
          ),
        ],
      ),
    );
    final remote = AudioIntelligenceRequest(
      recordingId: fixture.request.recordingId,
      generationId: fixture.request.generationId,
      processingLocation: AudioProcessingLocation.cloudDirect,
      consentDecision: AudioConsentDecision.granted,
      inputStartMs: 0,
      inputEndMs: 10000,
      segments: fixture.request.segments,
    );
    expect(
      () => AudioIntelligenceProviderBoundary(
        provider: provider,
        localOnly: true,
      ).generate(remote),
      throwsStateError,
    );
    expect(provider.invocationCount, 0);
  });
}
