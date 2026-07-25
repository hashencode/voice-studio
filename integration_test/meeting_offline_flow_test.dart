import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_review_service.dart';
import 'package:voice2text_flutter/features/meetings/controller/meeting_review_controller.dart';
import 'package:voice2text_flutter/features/meetings/meeting_detail_page.dart';
import 'package:voice2text_flutter/features/meetings/model/meeting_export_selection.dart';
import 'package:voice2text_flutter/features/meetings/model/meeting_time_range.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_export_service.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_playback_service.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_search_service.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_revisions_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_segments_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

import 'meeting_test_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const accessibilityGate = bool.fromEnvironment('DEVICE_ACCESSIBILITY_GATE');

  testWidgets(
    'timestamped meeting can play, edit, search, export and review evidence',
    (tester) async {
      final harness = await MeetingIntegrationHarness.create('offline-flow');
      addTearDown(harness.dispose);
      final db = harness.database;
      final recordingId = await db.insert('recordings', <String, Object?>{
        'file_path': harness.audioFile.path,
        'display_name': 'Offline flow fixture',
        'duration_ms': 5000,
        'created_at_ms': 1,
      });
      final generationId = await db
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': harness.audioFile.path,
            'status': 'active',
            'source': 'fixture',
            'merged_text': 'Alpha opening Decision ship',
            'created_at_ms': 1,
            'updated_at_ms': 1,
          });
      final segmentIds = <int>[];
      for (final entry in <(String, int, int)>[
        ('Alpha opening', 0, 2000),
        ('Decision ship', 2000, 5000),
      ]) {
        segmentIds.add(
          await db.insert('transcript_segments', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': harness.audioFile.path,
            'generation_id': generationId,
            'sequence_id': segmentIds.length,
            'text': entry.$1,
            'start_ms': entry.$2,
            'end_ms': entry.$3,
            'source': 'fixture',
            'created_at_ms': 1,
            'updated_at_ms': 1,
          }),
        );
      }
      await db.update(
        'recordings',
        <String, Object?>{'active_generation_id': generationId},
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
      final recordings = RecordingsRepository(database: harness.appDatabase);
      final intelligence = MeetingIntelligenceRepository(
        database: harness.appDatabase,
      );
      final review = MeetingIntelligenceReviewService(repository: intelligence);
      final playback = MeetingPlaybackService(
        backend: _IntegrationPlaybackBackend(),
      );
      final controller = MeetingReviewController(
        recordingId: recordingId,
        recordingsRepository: recordings,
        generationsRepository: TranscriptGenerationsRepository(
          database: harness.appDatabase,
        ),
        segmentsRepository: TranscriptSegmentsRepository(
          database: harness.appDatabase,
        ),
        jobsRepository: TranscriptionJobsRepository(
          database: harness.appDatabase,
        ),
        revisionsRepository: TranscriptRevisionsRepository(
          database: harness.appDatabase,
        ),
        searchService: MeetingSearchService(database: harness.appDatabase),
        playbackService: playback,
      );
      addTearDown(controller.dispose);
      await controller.load();

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: ThemeMode.system,
          builder: (context, child) => GooToastScope(
            child: GooSnackbarScope(child: child ?? const SizedBox.shrink()),
          ),
          home: MeetingDetailPage(
            recordingId: recordingId,
            controller: controller,
            intelligenceRepository: intelligence,
            intelligenceReviewService: review,
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Offline flow fixture'), findsOneWidget);
      expect(find.text('Alpha opening'), findsOneWidget);
      final semantics = tester.ensureSemantics();
      try {
        expect(find.bySemanticsLabel(RegExp('会议音频播放器')), findsOneWidget);
        expect(find.bySemanticsLabel('撤销最近一次转写编辑'), findsOneWidget);
        expect(find.bySemanticsLabel('重做最近一次撤销的转写编辑'), findsOneWidget);
        expect(find.bySemanticsLabel('导出并分享转写'), findsOneWidget);
        expect(find.bySemanticsLabel('管理片段 1'), findsOneWidget);
        if (accessibilityGate) {
          final context = tester.element(find.byType(MeetingDetailPage));
          expect(
            MediaQuery.textScalerOf(context).scale(1),
            greaterThanOrEqualTo(2),
          );
          expect(Theme.of(context).brightness, Brightness.dark);
          expect(
            MediaQuery.sizeOf(context).width,
            greaterThan(MediaQuery.sizeOf(context).height),
          );
        }

        await controller.seekToSegment(controller.meeting!.segments[1]);
        expect(controller.currentSegmentIndex, 1);
        await controller.saveSegment(
          segmentId: segmentIds[1],
          text: 'Decision: ship safely',
        );
        expect(controller.meeting!.segments[1].text, 'Decision: ship safely');
        expect(await controller.undoLastEdit(), isTrue);
        expect(await controller.redoLastEdit(), isTrue);
        expect(controller.meeting!.segments[1].text, 'Decision: ship safely');
        expect(
          await controller.updateReviewState(
            segmentId: segmentIds[0],
            state: TranscriptReviewState.needsReview,
          ),
          isTrue,
        );
        await controller.search(
          MeetingTranscriptQuery(
            text: 'alpha',
            timeRange: MeetingTimeRange(
              startMs: 0,
              endMs: 2000,
              durationMs: 5000,
            ),
            reviewState: TranscriptReviewState.needsReview,
          ),
        );
        expect(controller.searchResults.single.text, 'Alpha opening');
        expect(
          await controller.updateReviewState(
            segmentId: segmentIds[0],
            state: TranscriptReviewState.reviewed,
          ),
          isTrue,
        );

        final exportDirectory = Directory(
          '${harness.root.path}${Platform.pathSeparator}exports',
        );
        final exporter = MeetingExportService(
          recordingsRepository: recordings,
          exportDirectory: exportDirectory,
        );
        for (final format in MeetingExportFormat.values) {
          final receipt = await exporter.export(
            recordingId: recordingId,
            title: controller.meeting!.title,
            segments: controller.meeting!.segments,
            format: format,
          );
          expect(await File(receipt.path).exists(), isTrue);
        }
        final rangedVtt = await exporter.export(
          recordingId: recordingId,
          title: controller.meeting!.title,
          segments: controller.meeting!.segments,
          format: MeetingExportFormat.vtt,
          selection: MeetingExportSelection.range(
            MeetingTimeRange(startMs: 2000, endMs: 5000, durationMs: 5000),
          ),
        );
        final rangedVttContent = await File(rangedVtt.path).readAsString();
        expect(rangedVttContent, startsWith('WEBVTT\n\n1\n'));
        expect(rangedVttContent, contains('Decision: ship safely'));
        expect(rangedVttContent, isNot(contains('Alpha opening')));
        expect(rangedVttContent, contains('00:00:02.000 --> 00:00:05.000'));

        final provider = FixtureMeetingIntelligenceProvider(
          output: MeetingIntelligenceOutput(
            items: <MeetingInsightCandidate>[
              MeetingInsightCandidate(
                kind: MeetingInsightKind.decision,
                body: 'Ship safely.',
                evidence: <MeetingEvidenceCandidate>[
                  MeetingEvidenceCandidate(
                    segmentId: segmentIds[1],
                    startMs: 2000,
                    endMs: 5000,
                  ),
                ],
              ),
            ],
          ),
        );
        final bundle = await review.generateDraft(
          boundary: MeetingIntelligenceProviderBoundary(provider: provider),
          request: MeetingIntelligenceRequest(
            recordingId: recordingId,
            generationId: generationId,
            processingLocation: MeetingProcessingLocation.local,
            consentDecision: MeetingConsentDecision.granted,
            inputStartMs: 0,
            inputEndMs: 5000,
            segments: controller.meeting!.segments,
          ),
        );
        await review.markReviewed(bundle.insights.single.id);
        await review.publish(bundle.insights.single.id);
        expect(
          (await intelligence.findInsight(bundle.insights.single.id))?.status,
          MeetingInsightStatus.published,
        );
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets(
    '3000 segments stay lazy and support far review search and VTT export',
    (tester) async {
      final harness = await MeetingIntegrationHarness.create('large-flow');
      addTearDown(harness.dispose);
      final db = harness.database;
      final recordingId = await db.insert('recordings', <String, Object?>{
        'file_path': harness.audioFile.path,
        'display_name': 'Large offline flow fixture',
        'duration_ms': 3000000,
        'created_at_ms': 1,
      });
      final generationId = await db
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': harness.audioFile.path,
            'status': 'active',
            'source': 'fixture',
            'merged_text': '',
            'created_at_ms': 1,
            'updated_at_ms': 1,
      });
      final batch = db.batch();
      for (var index = 0; index < 3000; index += 1) {
        batch.insert('transcript_segments', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': harness.audioFile.path,
          'generation_id': generationId,
          'sequence_id': index,
          'text': index == 2999 ? 'Final searchable segment' : 'Segment $index',
          'start_ms': index * 1000,
          'end_ms': index * 1000 + 900,
          'source': 'fixture',
          'created_at_ms': 1,
          'updated_at_ms': 1,
        });
      }
      await batch.commit(noResult: true);
      await db.update(
        'recordings',
        <String, Object?>{'active_generation_id': generationId},
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
      final recordings = RecordingsRepository(database: harness.appDatabase);
      final controller = MeetingReviewController(
        recordingId: recordingId,
        recordingsRepository: recordings,
        generationsRepository: TranscriptGenerationsRepository(
          database: harness.appDatabase,
        ),
        segmentsRepository: TranscriptSegmentsRepository(
          database: harness.appDatabase,
        ),
        jobsRepository: TranscriptionJobsRepository(
          database: harness.appDatabase,
        ),
        revisionsRepository: TranscriptRevisionsRepository(
          database: harness.appDatabase,
        ),
        searchService: MeetingSearchService(database: harness.appDatabase),
        playbackService: MeetingPlaybackService(
          backend: _IntegrationPlaybackBackend(
            duration: const Duration(minutes: 50),
          ),
        ),
      );
      addTearDown(controller.dispose);
      await controller.load();
      expect(controller.meeting!.segments, hasLength(3000));

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: ThemeMode.system,
          builder: (context, child) => GooToastScope(
            child: GooSnackbarScope(child: child ?? const SizedBox.shrink()),
          ),
          home: MeetingDetailPage(
            recordingId: recordingId,
            controller: controller,
            intelligenceRepository: MeetingIntelligenceRepository(
              database: harness.appDatabase,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Segment 0'), findsOneWidget);
      expect(find.text('Final searchable segment'), findsNothing);

      await controller.seekToSegment(controller.meeting!.segments.last);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.takeException(), isNull);
      expect(find.text('Final searchable segment'), findsOneWidget);
      expect(find.text('Segment 0'), findsNothing);
      final finalSegment = controller.meeting!.segments.last;
      expect(
        await controller.updateReviewState(
          segmentId: finalSegment.id,
          state: TranscriptReviewState.reviewed,
        ),
        isTrue,
      );
      await controller.search(
        const MeetingTranscriptQuery(
          text: 'final searchable',
          reviewState: TranscriptReviewState.reviewed,
        ),
      );
      expect(controller.searchResults.single.sequenceId, 2999);

      final exporter = MeetingExportService(
        recordingsRepository: recordings,
        exportDirectory: Directory(
          '${harness.root.path}${Platform.pathSeparator}large-exports',
        ),
      );
      final receipt = await exporter.export(
        recordingId: recordingId,
        title: controller.meeting!.title,
        segments: controller.meeting!.segments,
        format: MeetingExportFormat.vtt,
      );
      final content = await File(receipt.path).readAsString();
      expect(content, startsWith('WEBVTT\n\n1\n'));
      expect(content, contains('\n3000\n'));
      expect(content, contains('Final searchable segment'));
      expect(content, contains('00:49:59.000 --> 00:49:59.900'));
    },
  );
}

class _IntegrationPlaybackBackend implements MeetingPlaybackBackend {
  _IntegrationPlaybackBackend({this.duration = const Duration(seconds: 5)});

  final Duration duration;
  final List<VoidCallback> _listeners = <VoidCallback>[];
  MeetingPlaybackSnapshot _snapshot = const MeetingPlaybackSnapshot.idle();

  @override
  MeetingPlaybackSnapshot get snapshot => _snapshot;

  @override
  void addListener(VoidCallback listener) => _listeners.add(listener);

  @override
  Future<void> initialize(String path) async {
    _snapshot = MeetingPlaybackSnapshot(
      initialized: true,
      playing: false,
      position: Duration.zero,
      duration: duration,
      speed: 1,
    );
  }

  @override
  Future<void> pause() async => _setPlaying(false);

  @override
  Future<void> play() async => _setPlaying(true);

  @override
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  @override
  Future<void> seekTo(Duration position) async {
    _snapshot = MeetingPlaybackSnapshot(
      initialized: true,
      playing: _snapshot.playing,
      position: position,
      duration: _snapshot.duration,
      speed: _snapshot.speed,
    );
    _emit();
  }

  @override
  Future<void> setSpeed(double speed) async {
    _snapshot = MeetingPlaybackSnapshot(
      initialized: true,
      playing: _snapshot.playing,
      position: _snapshot.position,
      duration: _snapshot.duration,
      speed: speed,
    );
    _emit();
  }

  void _setPlaying(bool playing) {
    _snapshot = MeetingPlaybackSnapshot(
      initialized: true,
      playing: playing,
      position: _snapshot.position,
      duration: _snapshot.duration,
      speed: _snapshot.speed,
    );
    _emit();
  }

  void _emit() {
    for (final listener in List<VoidCallback>.of(_listeners)) {
      listener();
    }
  }

  @override
  Future<void> dispose() async {}
}
