import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_insight_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_repository.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_review_service.dart';
import 'package:voice2text_flutter/features/audio_intelligence/widgets/audio_intelligence_section.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  testWidgets('empty production state says no provider is configured', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AudioIntelligenceSection(
            recordingId: 1,
            onEvidenceSelected: (_) {},
            skipInitialLoad: true,
          ),
        ),
      ),
    );
    expect(find.text('AI 音频洞察尚未生成'), findsOneWidget);
    expect(find.textContaining('默认不会上传音频内容'), findsOneWidget);
  });

  testWidgets(
    'generation states are explicit and recovery retry is confirmed',
    (tester) async {
      var confirmedRetry = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AudioIntelligenceSection(
              recordingId: 1,
              onEvidenceSelected: (_) {},
              skipInitialLoad: true,
              onGenerate: (confirmed) async => confirmedRetry = confirmed,
              generating: true,
            ),
          ),
        ),
      );

      expect(find.text('正在生成'), findsOneWidget);
      expect(find.textContaining('可随时取消'), findsOneWidget);
      expect(find.text('生成音频纪要'), findsOneWidget);
      await tester.tap(find.text('生成音频纪要'));
      expect(confirmedRetry, isFalse);
    },
  );

  testWidgets('fixture insight opens evidence review panel', (tester) async {
    final fixture = await tester.runAsync(createAudioIntelligenceFixture);
    if (fixture == null) {
      fail('Failed to create the audio intelligence fixture.');
    }
    addTearDown(fixture.database.close);
    final repository = AudioIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final reviewService = AudioIntelligenceReviewService(
      repository: repository,
    );
    final provider = FixtureAudioIntelligenceProvider(
      output: AudioIntelligenceOutput(
        items: <AudioInsightCandidate>[
          AudioInsightCandidate(
            kind: AudioInsightKind.decision,
            body: 'Ship the release.',
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
    final initialBundle = await tester.runAsync(() async {
      await reviewService.generateDraft(
        boundary: AudioIntelligenceProviderBoundary(provider: provider),
        request: fixture.request,
      );
      return repository.findLatestForRecording(fixture.recordingId);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AudioIntelligenceSection(
            recordingId: fixture.recordingId,
            repository: repository,
            reviewService: reviewService,
            onEvidenceSelected: (_) {},
            initialBundle: initialBundle,
            skipInitialLoad: true,
          ),
        ),
      ),
    );
    expect(find.text('Ship the release.'), findsOneWidget);
    await tester.tap(find.text('Ship the release.'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('有可播放证据'), findsOneWidget);
    expect(find.text('标记已审核'), findsOneWidget);
    await tester.tapAt(const Offset(8, 8));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('标记已审核'), findsNothing);
  });
}
