import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/evidence_link_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_note_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_validator.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/widgets/meeting_intelligence_section.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('synthetic structured note opens playable evidence', (
    tester,
  ) async {
    var evidenceSelected = false;
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            GooToastScope(child: child ?? const SizedBox.shrink()),
        home: Scaffold(
          body: MeetingIntelligenceSection(
            recordingId: 1,
            initialBundle: _bundle(),
            skipInitialLoad: true,
            onEvidenceSelected: (_) => evidenceSelected = true,
          ),
        ),
      ),
    );

    expect(find.text('虚构会议决定继续 S3 第一增量。'), findsOneWidget);
    expect(find.text('云端直连'), findsOneWidget);
    await tester.tap(find.text('虚构会议决定继续 S3 第一增量。'));
    await tester.pumpAndSettle();
    expect(find.text('有可播放证据'), findsOneWidget);
    await tester.tap(find.text('00:01 – 00:02'));
    await tester.pumpAndSettle();
    expect(evidenceSelected, isTrue);
  });

  testWidgets(
    'persisted synthetic generation and evidence survive database restart',
    (tester) async {
      final root = await Directory.systemTemp.createTemp(
        'voice2text-intelligence-restart-',
      );
      final databasePath = p.join(root.path, 'restart.db');
      Database? database;
      try {
        database = await openDatabase(
          databasePath,
          version: 1,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
          onCreate: (db, _) => AppDatabase.createCurrentSchema(db),
        );
        final appDatabase = AppDatabase.forTesting(database);
        final recordingId = await database
            .insert('recordings', <String, Object?>{
              'file_path': '/fictional-restart.m4a',
              'duration_ms': 5000,
              'created_at_ms': 1,
            });
        final generationId = await database
            .insert('transcript_generations', <String, Object?>{
              'recording_id': recordingId,
              'recording_path': '/fictional-restart.m4a',
              'status': 'active',
              'source': 'synthetic',
              'merged_text': '虚构会议决定继续 S3 第一增量。',
              'created_at_ms': 1,
              'updated_at_ms': 1,
            });
        final segmentId = await database
            .insert('transcript_segments', <String, Object?>{
              'recording_id': recordingId,
              'recording_path': '/fictional-restart.m4a',
              'generation_id': generationId,
              'sequence_id': 0,
              'text': '虚构会议决定继续 S3 第一增量。',
              'start_ms': 1000,
              'end_ms': 2000,
              'source': 'synthetic',
              'created_at_ms': 1,
              'updated_at_ms': 1,
            });
        await database.update(
          'recordings',
          <String, Object?>{'active_generation_id': generationId},
          where: 'id = ?',
          whereArgs: <Object>[recordingId],
        );
        final segment = TranscriptSegmentEntity(
          id: segmentId,
          recordingPath: '/fictional-restart.m4a',
          recordingId: recordingId,
          generationId: generationId,
          jobId: null,
          sequenceId: 0,
          text: '虚构会议决定继续 S3 第一增量。',
          startMs: 1000,
          endMs: 2000,
          isFinal: true,
          source: 'synthetic',
          confidence: null,
          createdAtMs: 1,
          updatedAtMs: 1,
        );
        final request = MeetingIntelligenceRequest(
          recordingId: recordingId,
          generationId: generationId,
          processingLocation: MeetingProcessingLocation.cloudDirect,
          consentDecision: MeetingConsentDecision.granted,
          inputStartMs: 0,
          inputEndMs: 5000,
          segments: <TranscriptSegmentEntity>[segment],
        );
        final provider = FixtureMeetingIntelligenceProvider(
          output: MeetingIntelligenceOutput(
            items: <MeetingInsightCandidate>[
              MeetingInsightCandidate(
                kind: MeetingInsightKind.summary,
                body: '重启后仍可复核的虚构摘要。',
                evidence: <MeetingEvidenceCandidate>[
                  MeetingEvidenceCandidate(
                    segmentId: segmentId,
                    startMs: 1000,
                    endMs: 2000,
                  ),
                ],
              ),
            ],
          ),
        );
        await MeetingIntelligenceRepository(database: appDatabase).createDraft(
          provider: provider,
          request: request,
          validated: const MeetingIntelligenceValidator().validate(
            request: request,
            output: provider.output,
          ),
        );
        await database.close();

        database = await openDatabase(
          databasePath,
          onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
        );
        final reopenedRepository = MeetingIntelligenceRepository(
          database: AppDatabase.forTesting(database),
        );
        final reopened = await reopenedRepository.findLatestForRecording(
          recordingId,
        );
        expect(reopened, isNotNull);
        expect(reopened!.insights.single.body, '重启后仍可复核的虚构摘要。');
        expect(reopened.evidenceByInsight.values.single, hasLength(1));

        var evidenceSelected = false;
        await tester.binding.setSurfaceSize(const Size(900, 430));
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData.dark(),
            builder: (context, child) {
              final media = MediaQuery.of(context);
              return MediaQuery(
                data: media.copyWith(textScaler: const TextScaler.linear(2)),
                child: GooToastScope(child: child ?? const SizedBox.shrink()),
              );
            },
            home: Scaffold(
              body: SingleChildScrollView(
                child: MeetingIntelligenceSection(
                  recordingId: recordingId,
                  initialBundle: reopened,
                  skipInitialLoad: true,
                  onEvidenceSelected: (_) => evidenceSelected = true,
                ),
              ),
            ),
          ),
        );
        await tester.ensureVisible(find.text('重启后仍可复核的虚构摘要。'));
        await tester.tap(find.text('重启后仍可复核的虚构摘要。'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('00:01 – 00:02'),
          120,
          scrollable: find.byType(Scrollable).last,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('00:01 – 00:02'));
        await tester.pumpAndSettle();
        expect(evidenceSelected, isTrue);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.binding.setSurfaceSize(null);
        if (database?.isOpen ?? false) await database?.close();
        if (await root.exists()) await root.delete(recursive: true);
      }
    },
  );
}

MeetingIntelligenceBundle _bundle() {
  const insight = MeetingInsightEntity(
    id: 1,
    noteId: 1,
    kind: MeetingInsightKind.summary,
    body: '虚构会议决定继续 S3 第一增量。',
    actionOwner: null,
    actionDueAtMs: null,
    unresolvedOwner: false,
    unresolvedDueDate: false,
    status: MeetingInsightStatus.draft,
    unsupported: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    reviewedAtMs: null,
    rejectedAtMs: null,
    publishedAtMs: null,
  );
  return const MeetingIntelligenceBundle(
    note: MeetingNoteEntity(
      id: 1,
      recordingId: 1,
      generationId: 1,
      status: MeetingNoteStatus.draft,
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      processingLocation: 'cloudDirect',
      consentGranted: true,
      inputStartMs: 0,
      inputEndMs: 5000,
      createdAtMs: 1,
      updatedAtMs: 1,
      reviewedAtMs: null,
      publishedAtMs: null,
    ),
    insights: <MeetingInsightEntity>[insight],
    evidenceByInsight: <int, List<EvidenceLinkEntity>>{
      1: <EvidenceLinkEntity>[
        EvidenceLinkEntity(
          id: 1,
          insightId: 1,
          segmentId: 1,
          startMs: 1000,
          endMs: 2000,
          createdAtMs: 1,
        ),
      ],
    },
  );
}
