import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/controller/meeting_review_controller.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_playback_service.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/model/recording_annotation_entity.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_annotations_repository.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_search_service.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_generations_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_revisions_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_segments_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test('current segment lookup uses start-inclusive end-exclusive bounds', () {
    final segments = <TranscriptSegmentEntity>[
      _segment(id: 1, start: 0, end: 1000),
      _segment(id: 2, start: 1000, end: 2000),
      _segment(id: 3, start: 2500, end: 3000),
    ];

    expect(MeetingReviewController.indexForPosition(segments, 0), 0);
    expect(MeetingReviewController.indexForPosition(segments, 999), 0);
    expect(MeetingReviewController.indexForPosition(segments, 1000), 1);
    expect(MeetingReviewController.indexForPosition(segments, 2000), isNull);
    expect(MeetingReviewController.indexForPosition(segments, 2500), 2);
    expect(MeetingReviewController.indexForPosition(segments, 3000), isNull);
  });

  test('lookup remains correct for thousands of segments', () {
    final segments = List<TranscriptSegmentEntity>.generate(
      5000,
      (index) =>
          _segment(id: index + 1, start: index * 1000, end: index * 1000 + 800),
    );
    expect(MeetingReviewController.indexForPosition(segments, 4321456), 4321);
  });

  test(
    'load edit undo redo and review state derive durable capabilities',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      const path = '/controller-review.m4a';
      final recordings = RecordingsRepository(database: fixture.appDatabase);
      await recordings.insert(filePath: path, durationMs: 4000);
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      await jobs.enqueue(recordingPath: path, durationMs: 4000);
      final job = await jobs.claimNextPending();
      final generations = TranscriptGenerationsRepository(
        database: fixture.appDatabase,
      );
      final committed = await generations.persistCompletedResult(
        job: job!,
        result: TranscriptionResult(
          mergedText: '原文',
          segments: <TranscriptionSegmentResult>[
            TranscriptionSegmentResult(
              sequenceId: 0,
              text: '原文',
              startMs: 100,
              endMs: 900,
              confidence: 0.42,
            ),
          ],
        ),
      );
      final segments = TranscriptSegmentsRepository(
        database: fixture.appDatabase,
      );
      final revisions = TranscriptRevisionsRepository(
        database: fixture.appDatabase,
      );
      MeetingReviewController buildController() => MeetingReviewController(
        recordingId: committed.generation.recordingId!,
        recordingsRepository: recordings,
        generationsRepository: generations,
        segmentsRepository: segments,
        jobsRepository: jobs,
        revisionsRepository: revisions,
        annotationsRepository: RecordingAnnotationsRepository(
          database: fixture.appDatabase,
        ),
        playbackService: MeetingPlaybackService(
          backend: _FakePlaybackBackend(),
        ),
      );

      final controller = buildController();
      addTearDown(controller.dispose);
      await controller.load();
      final segmentId = controller.meeting!.segments.single.id;
      expect(controller.meeting!.segments.single.confidence, 0.42);
      expect(controller.canUndo, isFalse);
      expect(controller.canRedo, isFalse);

      await controller.saveSegment(segmentId: segmentId, text: '修订');
      expect(controller.meeting!.segments.single.text, '修订');
      expect(controller.meeting!.segments.single.confidence, 0.42);
      expect(controller.canUndo, isTrue);
      expect(controller.canRedo, isFalse);

      expect(await controller.undoLastEdit(), isTrue);
      expect(controller.meeting!.segments.single.text, '原文');
      expect(controller.canUndo, isFalse);
      expect(controller.canRedo, isTrue);

      final reopened = buildController();
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.canRedo, isTrue);
      expect(await reopened.redoLastEdit(), isTrue);
      expect(reopened.meeting!.segments.single.text, '修订');
      expect(reopened.canUndo, isTrue);
      expect(reopened.canRedo, isFalse);

      expect(
        await reopened.updateReviewState(
          segmentId: segmentId,
          state: TranscriptReviewState.needsReview,
        ),
        isTrue,
      );
      expect(
        reopened.meeting!.segments.single.reviewState,
        TranscriptReviewState.needsReview,
      );
      expect(reopened.meeting!.segments.single.confidence, 0.42);
      expect(
        await reopened.updateReviewState(
          segmentId: segmentId,
          state: TranscriptReviewState.reviewed,
        ),
        isTrue,
      );
      expect(
        reopened.meeting!.segments.single.reviewState,
        TranscriptReviewState.reviewed,
      );
      expect(reopened.meeting!.segments.single.confidence, 0.42);
      expect(reopened.meeting!.segments.single.reviewedAtMs, isNotNull);
      expect(
        await reopened.updateReviewState(
          segmentId: segmentId,
          state: TranscriptReviewState.unreviewed,
        ),
        isTrue,
      );
      expect(reopened.meeting!.segments.single.reviewedAtMs, isNull);

      expect(
        await reopened.updateReviewState(
          segmentId: segmentId,
          generationId: committed.generation.id + 1,
          state: TranscriptReviewState.reviewed,
        ),
        isFalse,
      );
      expect(
        reopened.meeting!.segments.single.reviewState,
        TranscriptReviewState.unreviewed,
      );
    },
  );

  test('new query and clear suppress stale search results', () async {
    final searchService = _ControlledSearchService();
    final backend = _FakePlaybackBackend();
    final controller = MeetingReviewController(
      recordingId: 1,
      searchService: searchService,
      playbackService: MeetingPlaybackService(backend: backend),
    );
    addTearDown(controller.dispose);
    const oldQuery = MeetingTranscriptQuery(text: 'old');
    const newQuery = MeetingTranscriptQuery(text: 'new');

    final oldSearch = controller.search(oldQuery);
    final newSearch = controller.search(newQuery);
    searchService.complete('new', <TranscriptSegmentEntity>[
      _segment(id: 2, start: 1000, end: 2000),
    ]);
    await newSearch;
    searchService.complete('old', <TranscriptSegmentEntity>[
      _segment(id: 1, start: 0, end: 900),
    ]);
    await oldSearch;

    expect(controller.searchQuery, newQuery);
    expect(controller.searchResults.single.id, 2);

    final pending = controller.search(oldQuery);
    controller.clearSearch();
    searchService.complete('old', <TranscriptSegmentEntity>[
      _segment(id: 1, start: 0, end: 900),
    ]);
    await pending;
    expect(controller.searchQuery.isEmpty, isTrue);
    expect(controller.searchResults, isEmpty);
  });

  test('database load failure exits the loading state', () async {
    final fixture = await openRecordingTestDatabase();
    await fixture.database.close();
    final controller = MeetingReviewController(
      recordingId: 1,
      recordingsRepository: RecordingsRepository(database: fixture.appDatabase),
      playbackService: MeetingPlaybackService(backend: _FakePlaybackBackend()),
    );
    addTearDown(controller.dispose);

    await controller.load();

    expect(controller.loading, isFalse);
    expect(controller.error, '会议工作区加载失败');
  });

  test(
    'selecting a result seeks to its start and resumes auto follow',
    () async {
      final backend = _FakePlaybackBackend();
      final controller = MeetingReviewController(
        recordingId: 1,
        playbackService: MeetingPlaybackService(backend: backend),
      );
      addTearDown(controller.dispose);
      controller.suspendAutoFollow();
      expect(controller.autoFollow, isFalse);

      await controller.seekToSegment(_segment(id: 4, start: 4321, end: 5000));

      expect(backend.lastSeek, const Duration(milliseconds: 4321));
      expect(controller.autoFollow, isTrue);
    },
  );

  test(
    'load exposes durable recording annotations and seeks to their time',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final annotations = RecordingAnnotationsRepository(
        database: fixture.appDatabase,
      );
      await sessions.upsertSnapshot(
        const RecordingSessionSnapshot(
          sessionId: 'review-annotations',
          state: 'recording',
          durationMs: 2_000,
        ),
      );
      await annotations.addMarker(
        sessionId: 'review-annotations',
        positionMs: 1_250,
      );
      final recordingId = await sessions.commitCompleted(
        const RecorderResult(
          sessionId: 'review-annotations',
          path: '/review-annotations.m4a',
          durationMs: 3_000,
        ),
      );
      final backend = _FakePlaybackBackend();
      final controller = MeetingReviewController(
        recordingId: recordingId,
        recordingsRepository: RecordingsRepository(
          database: fixture.appDatabase,
        ),
        generationsRepository: TranscriptGenerationsRepository(
          database: fixture.appDatabase,
        ),
        segmentsRepository: TranscriptSegmentsRepository(
          database: fixture.appDatabase,
        ),
        jobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        revisionsRepository: TranscriptRevisionsRepository(
          database: fixture.appDatabase,
        ),
        annotationsRepository: annotations,
        playbackService: MeetingPlaybackService(backend: backend),
      );
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.meeting!.annotations, hasLength(1));
      expect(
        controller.meeting!.annotations.single.kind,
        RecordingAnnotationKind.marker,
      );
      await controller.seekToAnnotation(controller.meeting!.annotations.single);
      expect(backend.lastSeek, const Duration(milliseconds: 1_250));
    },
  );
}

TranscriptSegmentEntity _segment({
  required int id,
  required int start,
  required int end,
}) {
  return TranscriptSegmentEntity(
    id: id,
    recordingPath: '/meeting.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: id - 1,
    text: 'segment $id',
    startMs: start,
    endMs: end,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}

class _FakePlaybackBackend implements MeetingPlaybackBackend {
  VoidCallback? _listener;
  Duration? lastSeek;

  @override
  MeetingPlaybackSnapshot get snapshot => const MeetingPlaybackSnapshot(
    initialized: true,
    playing: false,
    position: Duration.zero,
    duration: Duration(seconds: 4),
    speed: 1,
  );

  @override
  void addListener(VoidCallback listener) => _listener = listener;

  @override
  Future<void> dispose() async {}

  @override
  Future<void> initialize(String path) async {}

  @override
  Future<void> pause() async {}

  @override
  Future<void> play() async {}

  @override
  void removeListener(VoidCallback listener) {
    if (identical(_listener, listener)) _listener = null;
  }

  @override
  Future<void> seekTo(Duration position) async {
    lastSeek = position;
  }

  @override
  Future<void> setSpeed(double speed) async {}
}

class _ControlledSearchService extends MeetingSearchService {
  final Map<String, Completer<List<TranscriptSegmentEntity>>> _pending =
      <String, Completer<List<TranscriptSegmentEntity>>>{};

  @override
  Future<List<TranscriptSegmentEntity>> search({
    required int recordingId,
    required MeetingTranscriptQuery query,
    int limit = 200,
  }) {
    final completer = Completer<List<TranscriptSegmentEntity>>();
    _pending[query.normalizedText] = completer;
    return completer.future;
  }

  void complete(String text, List<TranscriptSegmentEntity> results) {
    _pending.remove(text)!.complete(results);
  }
}
