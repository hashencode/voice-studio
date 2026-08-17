import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_template.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_validator.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test('processing location maps legacy storage values', () {
    expect(
      AudioProcessingLocation.fromStorage('local'),
      AudioProcessingLocation.onDevice,
    );
    expect(
      AudioProcessingLocation.fromStorage('remote'),
      AudioProcessingLocation.cloudDirect,
    );
    expect(
      AudioProcessingLocation.fromStorage('pairedPc'),
      AudioProcessingLocation.pairedPc,
    );
    expect(
      AudioProcessingLocation.fromStorage('unknown'),
      AudioProcessingLocation.onDevice,
    );
  });

  test('all product templates have stable unique identifiers', () {
    expect(AudioTemplate.known, hasLength(7));
    expect(
      AudioTemplate.known.map((template) => template.id).toSet(),
      hasLength(7),
    );
    expect(AudioTemplate.find(AudioTemplateId.retrospective).label, '复盘');
  });

  test('validator carries S3 metadata and validates topic range', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final provider = FixtureAudioIntelligenceProvider(
      output: AudioIntelligenceOutput(
        audioType: '评审',
        suggestedTitle: 'S3 review',
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.topic,
            body: 'Product scope',
            topicStartMs: 1000,
            topicEndMs: 4000,
            sortOrder: 3,
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1000,
                endMs: 4000,
              ),
            ],
          ),
        ],
      ),
    );

    final validated = const AudioIntelligenceValidator().validate(
      request: fixture.request,
      output: provider.output,
    );
    expect(validated.schemaVersion, 'audio_intelligence_output/v1');
    expect(validated.audioType, '评审');
    expect(validated.suggestedTitle, 'S3 review');
    expect(validated.items.single.candidate.sortOrder, 3);
  });

  test('validator rejects unknown output schema', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);

    expect(
      () => const AudioIntelligenceValidator().validate(
        request: fixture.request,
        output: const AudioIntelligenceOutput(
          schemaVersion: 'audio_intelligence_output/v2',
          items: <AudioInsightCandidate>[],
        ),
      ),
      throwsFormatException,
    );
  });
}
