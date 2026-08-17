import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_validator.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test('validates supported decision with multiple evidence links', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validator = const AudioIntelligenceValidator();
    final validated = validator.validate(
      request: fixture.request,
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.decision,
            body: 'Ship the release.',
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 1100,
                endMs: 2000,
              ),
              AudioEvidenceCandidate(
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
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validated = const AudioIntelligenceValidator().validate(
      request: fixture.request,
      output: const AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.summary,
            body: 'Unsupported draft.',
          ),
        ],
      ),
    );
    expect(validated.items.single.unsupported, isTrue);
  });

  test('action keeps missing owner and due date unresolved', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    final validated = const AudioIntelligenceValidator().validate(
      request: fixture.request,
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.action,
            body: 'Prepare rollout.',
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
    expect(validated.items.single.unresolvedOwner, isTrue);
    expect(validated.items.single.unresolvedDueDate, isTrue);
  });

  test('marks nonexistent and out-of-range evidence unsupported', () async {
    final fixture = await createAudioIntelligenceFixture();
    addTearDown(fixture.database.close);
    const validator = AudioIntelligenceValidator();
    final nonexistent = validator.validate(
      request: fixture.request,
      output: const AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.risk,
            body: 'Risk.',
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(segmentId: 9999, startMs: 1, endMs: 2),
            ],
          ),
        ],
      ),
    );
    expect(nonexistent.items.single.unsupported, isTrue);
    expect(nonexistent.items.single.candidate.evidence, isEmpty);

    final outOfRange = validator.validate(
      request: fixture.request,
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.risk,
            body: 'Risk.',
            evidence: <AudioEvidenceCandidate>[
              AudioEvidenceCandidate(
                segmentId: fixture.segment.id,
                startMs: 500,
                endMs: 4500,
              ),
            ],
          ),
        ],
      ),
    );
    expect(outOfRange.items.single.unsupported, isTrue);
    expect(outOfRange.items.single.candidate.evidence, isEmpty);
  });
}
