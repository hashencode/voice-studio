import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_review_service.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/widgets/meeting_intelligence_section.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  testWidgets('empty production state says no provider is configured', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MeetingIntelligenceSection(
            recordingId: 1,
            onEvidenceSelected: (_) {},
            skipInitialLoad: true,
          ),
        ),
      ),
    );
    expect(find.text('AI 会议洞察尚未生成'), findsOneWidget);
    expect(find.textContaining('未配置生产提供商'), findsOneWidget);
  });

  testWidgets('fixture insight opens evidence review panel', (tester) async {
    final fixture = await tester.runAsync(createMeetingIntelligenceFixture);
    if (fixture == null) {
      fail('Failed to create the meeting intelligence fixture.');
    }
    addTearDown(fixture.database.close);
    final repository = MeetingIntelligenceRepository(
      database: fixture.appDatabase,
    );
    final reviewService = MeetingIntelligenceReviewService(
      repository: repository,
    );
    final provider = FixtureMeetingIntelligenceProvider(
      output: MeetingIntelligenceOutput(
        items: <MeetingInsightCandidate>[
          MeetingInsightCandidate(
            kind: MeetingInsightKind.decision,
            body: 'Ship the release.',
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
    final initialBundle = await tester.runAsync(() async {
      await reviewService.generateDraft(
        boundary: MeetingIntelligenceProviderBoundary(provider: provider),
        request: fixture.request,
      );
      return repository.findLatestForRecording(fixture.recordingId);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MeetingIntelligenceSection(
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
