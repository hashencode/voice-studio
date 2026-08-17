import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/meetings/data/desktop_meeting_workspace_repository.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_engine.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test(
    'processing, review, search, undo/redo and manual speaker edits survive retry',
    () async {
      final fixture = await _Fixture.open();
      addTearDown(fixture.dispose);
      const candidate = MeetingMediaCandidate(
        path: '/private/imports/meeting.wav',
        displayName: '项目周会.wav',
        sizeBytes: 4096,
        durationMs: 6000,
        fingerprintSha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        duplicateAsset: false,
      );
      await fixture.processing.commitImported(candidate);
      final job = (await fixture.processing.claimNext())!;
      await fixture.processing.completeWithResult(job, _partialResult());

      final library = await fixture.workspace.listMeetings(query: '项目');
      expect(library, hasLength(1));
      expect(
        library.single.processingState,
        MeetingWorkspaceProcessingState.partialSuccess,
      );
      var workspace = (await fixture.workspace.openMeeting(job.recordingId))!;
      expect(workspace.segments, hasLength(3));
      expect(workspace.speakers, hasLength(2));
      expect(
        workspace.segments.map((segment) => segment.speakerState),
        containsAll(<MeetingWorkspaceSpeakerState>[
          MeetingWorkspaceSpeakerState.assigned,
          MeetingWorkspaceSpeakerState.overlap,
        ]),
      );

      final first = workspace.segments.first;
      expect(
        await fixture.workspace.searchTranscript(
          recordingId: job.recordingId,
          query: '发布',
          startMs: 0,
          endMs: 2000,
        ),
        hasLength(2),
      );
      expect(
        await fixture.workspace.saveSegment(
          segmentId: first.id,
          text: '修订：确认下周发布。',
          reviewState: MeetingWorkspaceReviewState.reviewed,
        ),
        isTrue,
      );
      workspace = (await fixture.workspace.openMeeting(job.recordingId))!;
      expect(workspace.segments.first.text, startsWith('修订'));
      expect(
        workspace.segments.first.reviewState,
        MeetingWorkspaceReviewState.reviewed,
      );
      expect(workspace.canUndo, isTrue);
      expect(
        await fixture.workspace.undo(workspace.summary.generationId!),
        isTrue,
      );
      expect(
        (await fixture.workspace.openMeeting(
          job.recordingId,
        ))!.segments.first.text,
        '确认下周发布。',
      );
      expect(
        await fixture.workspace.redo(workspace.summary.generationId!),
        isTrue,
      );

      workspace = (await fixture.workspace.openMeeting(job.recordingId))!;
      final target = workspace.speakers.first;
      await fixture.workspace.renameSpeakers(<int, String>{target.id: '主持人'});
      await fixture.workspace.assignSpeaker(
        generationId: workspace.summary.generationId!,
        segmentId: workspace.segments[1].id,
        speakerId: target.id,
        state: MeetingWorkspaceSpeakerState.assigned,
      );

      expect(await fixture.processing.retry(job.id), isTrue);
      final retryJob = (await fixture.processing.claimNext())!;
      await fixture.processing.completeWithResult(retryJob, _retryResult());
      final retried = (await fixture.workspace.openMeeting(job.recordingId))!;

      expect(retried.segments.first.text, '修订：确认下周发布。');
      expect(retried.segments[1].speakerId, target.id);
      expect(retried.segments[1].speakerSource, 'manual');
      expect(
        retried.speakers
            .firstWhere((speaker) => speaker.id == target.id)
            .displayName,
        '主持人',
      );
      expect(
        retried.summary.processingState,
        MeetingWorkspaceProcessingState.completed,
      );
    },
  );

  test('3000-segment open and indexed search stay bounded', () async {
    final fixture = await _Fixture.open();
    addTearDown(fixture.dispose);
    await fixture.processing.commitImported(
      const MeetingMediaCandidate(
        path: '/private/imports/long.wav',
        displayName: '两小时会议.wav',
        sizeBytes: 10 * 1024 * 1024,
        durationMs: 2 * 60 * 60 * 1000,
        fingerprintSha256:
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        duplicateAsset: false,
      ),
    );
    final job = (await fixture.processing.claimNext())!;
    final segments = List<ProcessingTranscriptSegment>.generate(
      3001,
      (index) => ProcessingTranscriptSegment(
        startSeconds: index * 2.0,
        endSeconds: index * 2.0 + 1.5,
        text: index == 2999 ? '唯一检索目标' : '会议片段 $index',
        speakerAssignment: SpeakerAssignment.anonymous,
        anonymousSpeakerKey: 'speaker-${index % 5}',
      ),
      growable: false,
    );
    await fixture.processing.completeWithResult(
      job,
      DesktopProcessingResult(
        segments: segments,
        engineId: 'test',
        elapsedMilliseconds: 1,
        peakResidentBytes: 1,
        diarizationSucceeded: true,
      ),
    );

    // Warm the statement cache before the fixed 20-sample gate.
    await fixture.workspace.openMeeting(job.recordingId);
    await fixture.workspace.searchTranscript(
      recordingId: job.recordingId,
      query: '唯一检索目标',
      limit: 20,
    );

    final openSamples = <int>[];
    final searchSamples = <int>[];
    for (var index = 0; index < 20; index++) {
      final openWatch = Stopwatch()..start();
      final workspace = await fixture.workspace.openMeeting(job.recordingId);
      openWatch.stop();
      expect(workspace?.segments, hasLength(3001));
      openSamples.add(openWatch.elapsedMicroseconds);

      final searchWatch = Stopwatch()..start();
      final search = await fixture.workspace.searchTranscript(
        recordingId: job.recordingId,
        query: '唯一检索目标',
        limit: 20,
      );
      searchWatch.stop();
      expect(search.single.sequenceId, 2999);
      searchSamples.add(searchWatch.elapsedMicroseconds);
    }
    openSamples.sort();
    searchSamples.sort();
    final openP95Micros = openSamples[18];
    final searchP95Micros = searchSamples[18];
    final evidence = jsonEncode(<String, Object>{
      'segmentCount': 3001,
      'sampleCount': 20,
      'openP95Micros': openP95Micros,
      'openMaxMicros': openSamples.last,
      'searchP95Micros': searchP95Micros,
      'searchMaxMicros': searchSamples.last,
    });
    // This line is captured verbatim in the target-host U9 evidence.
    // ignore: avoid_print
    print('U9_INTERACTION_EVIDENCE=$evidence');
    expect(openP95Micros, lessThan(2000000));
    expect(searchP95Micros, lessThan(200000));
  });
}

DesktopProcessingResult _partialResult() => const DesktopProcessingResult(
  segments: <ProcessingTranscriptSegment>[
    ProcessingTranscriptSegment(
      startSeconds: 0,
      endSeconds: 1.5,
      text: '确认下周发布。',
      speakerAssignment: SpeakerAssignment.anonymous,
      anonymousSpeakerKey: 'speaker-a',
    ),
    ProcessingTranscriptSegment(
      startSeconds: 1.5,
      endSeconds: 3,
      text: '我会准备发布清单。',
      speakerAssignment: SpeakerAssignment.anonymous,
      anonymousSpeakerKey: 'speaker-b',
    ),
    ProcessingTranscriptSegment(
      startSeconds: 3,
      endSeconds: 5,
      text: '好的。',
      speakerAssignment: SpeakerAssignment.overlap,
    ),
  ],
  engineId: 'test-frozen-engine',
  elapsedMilliseconds: 10,
  peakResidentBytes: 1024,
  diarizationSucceeded: false,
  diarizationErrorCode: 'DIARIZATION_FAILED',
);

DesktopProcessingResult _retryResult() => const DesktopProcessingResult(
  segments: <ProcessingTranscriptSegment>[
    ProcessingTranscriptSegment(
      startSeconds: 0,
      endSeconds: 1.5,
      text: '机器重跑不应覆盖修订',
      speakerAssignment: SpeakerAssignment.anonymous,
      anonymousSpeakerKey: 'speaker-b',
    ),
    ProcessingTranscriptSegment(
      startSeconds: 1.5,
      endSeconds: 3,
      text: '机器重跑不应覆盖手工说话人',
      speakerAssignment: SpeakerAssignment.anonymous,
      anonymousSpeakerKey: 'speaker-a',
    ),
    ProcessingTranscriptSegment(
      startSeconds: 3,
      endSeconds: 5,
      text: '机器重跑',
      speakerAssignment: SpeakerAssignment.unknown,
    ),
  ],
  engineId: 'test-frozen-engine',
  elapsedMilliseconds: 10,
  peakResidentBytes: 1024,
  diarizationSucceeded: true,
);

class _Fixture {
  const _Fixture({
    required this.root,
    required this.database,
    required this.processing,
    required this.workspace,
  });

  static Future<_Fixture> open() async {
    final root = await Directory.systemTemp.createTemp('workspace-repo-test-');
    final databaseDirectory = Directory(p.join(root.path, 'database'));
    await databaseDirectory.create();
    final database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => databaseDirectory.path,
      databaseName: 'workspace-test.db',
    );
    return _Fixture(
      root: root,
      database: database,
      processing: DesktopProcessingRepository(database: database),
      workspace: DesktopMeetingWorkspaceRepository(database: database),
    );
  }

  final Directory root;
  final AppDatabase database;
  final DesktopProcessingRepository processing;
  final DesktopMeetingWorkspaceRepository workspace;

  Future<void> dispose() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  }
}
