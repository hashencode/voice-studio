import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:voice2text_desktop/features/captions/live_caption_models.dart';
import 'package:voice2text_desktop/features/captions/live_caption_repository.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_engine.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';

void main() {
  sqfliteFfiInit();

  late Directory root;
  late AppDatabase database;
  late DesktopCaptureRepository capture;
  late LiveCaptionRepository captions;
  late DesktopProcessingRepository processing;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('draft-formal-');
    database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'test.db',
    );
    capture = DesktopCaptureRepository(database);
    captions = LiveCaptionRepository(database: database);
    processing = DesktopProcessingRepository(database: database);
  });

  tearDown(() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  });

  test(
    'draft utterances are ordered, bounded, and replay-idempotent',
    () async {
      final session = await _begin(capture, captions, root);
      final utterance = LiveCaptionUtterance(
        sessionId: session.sessionId,
        generationId: session.generationId,
        sequence: 1,
        startMs: 100,
        endMs: 900,
        text: '会议开始',
        language: 'zh',
        modelSha256: _modelHash,
        workerOffsetBytes: 32000,
      );
      expect(await captions.appendUtterance(utterance, nowMs: 20), isTrue);
      expect(await captions.appendUtterance(utterance, nowMs: 21), isFalse);
      await expectLater(
        captions.appendUtterance(
          LiveCaptionUtterance(
            sessionId: session.sessionId,
            generationId: session.generationId,
            sequence: 3,
            startMs: 1000,
            endMs: 1200,
            text: '乱序',
            language: 'zh',
            modelSha256: _modelHash,
            workerOffsetBytes: 64000,
          ),
          nowMs: 22,
        ),
        throwsStateError,
      );
      await expectLater(
        captions.appendUtterance(
          LiveCaptionUtterance(
            sessionId: session.sessionId,
            generationId: session.generationId,
            sequence: 2,
            startMs: 1000,
            endMs: 3000,
            text: '越界',
            language: 'zh',
            modelSha256: _modelHash,
            workerOffsetBytes: 32000,
          ),
          nowMs: 23,
        ),
        throwsStateError,
      );
      final rows = await (await database.database).query('transcript_segments');
      expect(rows, hasLength(1));
    },
  );

  test(
    'formal output protects edits and reconcile remains reversible',
    () async {
      final session = await _begin(capture, captions, root);
      await captions.appendUtterance(
        LiveCaptionUtterance(
          sessionId: session.sessionId,
          generationId: session.generationId,
          sequence: 1,
          startMs: 0,
          endMs: 900,
          text: '人工修改前',
          language: 'zh',
          modelSha256: _modelHash,
          workerOffsetBytes: 32000,
        ),
        nowMs: 20,
      );
      final recordingId = await _commitRecording(
        database,
        capture,
        session.sessionId,
        root,
      );
      await captions.attachCommittedRecording(
        sessionId: session.sessionId,
        recordingId: recordingId,
        recordingPath: '${root.path}/journal.json',
        nowMs: 40,
      );
      final db = await database.database;
      await db.update(
        'transcript_generations',
        <String, Object?>{'has_user_edits': 1},
        where: 'id = ?',
        whereArgs: <Object?>[session.generationId],
      );

      final queued = await processing.enqueuePostMeeting(
        CommittedMeetingCapture(
          sessionId: session.sessionId,
          recordingId: recordingId,
          recordingPath: '${root.path}/journal.json',
          processingPath: '${root.path}/processing.wav',
          recordingSha256: _recordingHash,
          durationMs: 2000,
          partialCapture: false,
        ),
      );
      expect(queued.inserted, isTrue);
      expect(
        (await processing.enqueuePostMeeting(
          CommittedMeetingCapture(
            sessionId: session.sessionId,
            recordingId: recordingId,
            recordingPath: '${root.path}/journal.json',
            processingPath: '${root.path}/processing.wav',
            recordingSha256: _recordingHash,
            durationMs: 2000,
            partialCapture: false,
          ),
        )).inserted,
        isFalse,
      );
      final job = (await processing.claimNext())!;
      await processing.completeWithResult(job, _formalResult());

      final recording = (await db.query(
        'recordings',
        columns: <String>['active_generation_id'],
        where: 'id = ?',
        whereArgs: <Object?>[recordingId],
      )).single;
      expect(recording['active_generation_id'], isNull);
      final formal = (await db.query(
        'transcript_generations',
        where: 'job_id = ?',
        whereArgs: <Object?>[job.id],
      )).single;
      expect(formal['generation_kind'], 'formal');
      expect(formal['source'], qwen3PostMeetingSource);
      expect(formal['supersedes_generation_id'], session.generationId);
      expect(formal['reconciliation_state'], 'pending');
      expect(
        (await captions.displayForRecording(recordingId)).authority,
        TranscriptDisplayAuthority.revisionRequired,
      );

      final formalId = formal['id']! as int;
      await captions.reconcile(
        formalGenerationId: formalId,
        choice: TranscriptReconciliationChoice.acceptFormal,
        nowMs: 60,
      );
      expect(
        (await captions.displayForRecording(recordingId)).generationId,
        formalId,
      );
      await captions.reconcile(
        formalGenerationId: formalId,
        choice: TranscriptReconciliationChoice.keepDraft,
        nowMs: 61,
      );
      expect(
        (await captions.displayForRecording(recordingId)).generationId,
        session.generationId,
      );
    },
  );

  test('partial formal output never becomes active', () async {
    final session = await _begin(capture, captions, root);
    final recordingId = await _commitRecording(
      database,
      capture,
      session.sessionId,
      root,
    );
    await captions.attachCommittedRecording(
      sessionId: session.sessionId,
      recordingId: recordingId,
      recordingPath: '${root.path}/journal.json',
      nowMs: 40,
    );
    await processing.enqueuePostMeeting(
      CommittedMeetingCapture(
        sessionId: session.sessionId,
        recordingId: recordingId,
        recordingPath: '${root.path}/journal.json',
        processingPath: '${root.path}/processing.wav',
        recordingSha256: _recordingHash,
        durationMs: 2000,
        partialCapture: false,
      ),
    );
    final job = (await processing.claimNext())!;
    await processing.completeWithResult(
      job,
      DesktopProcessingResult(
        segments: _formalResult().segments,
        engineId: 'test',
        elapsedMilliseconds: 1,
        peakResidentBytes: 1,
        diarizationSucceeded: true,
        transcriptComplete: false,
      ),
    );
    final row = (await (await database.database).query(
      'recordings',
      columns: <String>['active_generation_id'],
      where: 'id = ?',
      whereArgs: <Object?>[recordingId],
    )).single;
    expect(row['active_generation_id'], isNull);
  });
}

const String _modelHash =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String _recordingHash =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

Future<LiveCaptionSessionRecord> _begin(
  DesktopCaptureRepository capture,
  LiveCaptionRepository captions,
  Directory root,
) async {
  const sessionId = 'session-u14-test-1234';
  await capture.beginSession(
    sessionId: sessionId,
    workspacePath: root.path,
    nowMs: 10,
  );
  return captions.createOrResume(
    sessionId: sessionId,
    workspacePath: root.path,
    modelSha256: _modelHash,
    profileId: senseVoiceU18ControlProfile,
    nowMs: 11,
  );
}

Future<int> _commitRecording(
  AppDatabase owner,
  DesktopCaptureRepository capture,
  String sessionId,
  Directory root,
) async {
  final database = await owner.database;
  final recordingId = await database.insert('recordings', <String, Object?>{
    'file_path': '${root.path}/journal.json',
    'display_name': 'U14',
    'session_id': sessionId,
    'asset_kind': 'desktop_capture_manifest',
    'fingerprint_sha256': _recordingHash,
    'duration_ms': 2000,
    'created_at_ms': 30,
  });
  await capture.commitRecording(
    sessionId: sessionId,
    recordingId: recordingId,
    recordingSha256: _recordingHash,
    partialCapture: false,
    idempotencyKey: 'stop-u14-test-1234',
    result: const <String, Object?>{'state': 'completed'},
    nowMs: 31,
  );
  return recordingId;
}

DesktopProcessingResult _formalResult() {
  return const DesktopProcessingResult(
    segments: <ProcessingTranscriptSegment>[
      ProcessingTranscriptSegment(
        startSeconds: 0,
        endSeconds: 1.5,
        text: '正式结果',
        speakerAssignment: SpeakerAssignment.unknown,
      ),
    ],
    engineId: 'test',
    elapsedMilliseconds: 1,
    peakResidentBytes: 1,
    diarizationSucceeded: true,
  );
}
