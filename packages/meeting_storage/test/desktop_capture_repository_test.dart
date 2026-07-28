import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  late Directory root;
  late AppDatabase owner;
  late DesktopCaptureRepository repository;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('capture-repository-');
    owner = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'capture.db',
    );
    repository = DesktopCaptureRepository(owner);
  });

  tearDown(() async {
    await (await owner.database).close();
    await root.delete(recursive: true);
  });

  test('durable chunks and command receipts are idempotent', () async {
    const sessionId = 'session-123456789abc';
    final created = await repository.beginSession(
      sessionId: sessionId,
      workspacePath: '${root.path}/$sessionId',
      nowMs: 10,
    );
    expect(created.state, 'preparing');

    for (final track in <DesktopCaptureTrackRecord>[
      const DesktopCaptureTrackRecord(
        sessionId: sessionId,
        kind: 'system_audio',
        healthy: true,
        sampleRate: 48000,
        channels: 2,
        format: 'pcm-f32le',
      ),
      const DesktopCaptureTrackRecord(
        sessionId: sessionId,
        kind: 'microphone',
        healthy: true,
        sampleRate: 48000,
        channels: 1,
        format: 'pcm-f32le',
      ),
    ]) {
      await repository.upsertTrack(track);
    }

    const chunk = DesktopCaptureChunkRecord(
      sessionId: sessionId,
      trackKind: 'system_audio',
      sequence: 0,
      startMs: 0,
      endMs: 5000,
      relativePath: 'system/chunk-000000.caf',
      bytes: 1920000,
      sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      createdAtMs: 20,
    );
    await repository.recordChunk(chunk);
    await repository.recordChunk(chunk);
    await expectLater(
      repository.recordChunk(
        const DesktopCaptureChunkRecord(
          sessionId: sessionId,
          trackKind: 'system_audio',
          sequence: 0,
          startMs: 0,
          endMs: 5000,
          relativePath: 'system/chunk-000000.caf',
          bytes: 1920000,
          sha256:
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          createdAtMs: 20,
        ),
      ),
      throwsStateError,
    );

    const startResult = <String, Object?>{
      'sessionId': sessionId,
      'state': 'recording',
      'captureTimelineMs': 0,
    };
    await repository.saveSnapshotAndReceipt(
      sessionId: sessionId,
      state: 'recording',
      captureTimelineMs: 0,
      partialCapture: false,
      action: 'start',
      idempotencyKey: 'start-123456789abc',
      result: startResult,
      nowMs: 30,
    );
    await repository.saveSnapshotAndReceipt(
      sessionId: sessionId,
      state: 'recording',
      captureTimelineMs: 0,
      partialCapture: false,
      action: 'start',
      idempotencyKey: 'start-123456789abc',
      result: startResult,
      nowMs: 31,
    );
    final receipt = await repository.commandReceipt(
      sessionId: sessionId,
      idempotencyKey: 'start-123456789abc',
    );
    expect(receipt?.result, startResult);
    expect(
      (await repository.recoverableSessions()).single.sessionId,
      sessionId,
    );
  });

  test(
    'recording commit is stable and terminal sessions are not recovered',
    () async {
      const sessionId = 'session-abcdef123456';
      await repository.beginSession(
        sessionId: sessionId,
        workspacePath: '${root.path}/$sessionId',
        nowMs: 10,
      );
      await repository.saveSnapshotAndReceipt(
        sessionId: sessionId,
        state: 'recording',
        captureTimelineMs: 0,
        partialCapture: false,
        action: 'start',
        idempotencyKey: 'start-abcdef123456',
        result: const <String, Object?>{'state': 'recording'},
        nowMs: 20,
      );
      final database = await owner.database;
      final recordingId = await database.insert('recordings', <String, Object?>{
        'file_path': '${root.path}/recording.caf',
        'session_id': sessionId,
        'duration_ms': 5000,
        'created_at_ms': 30,
      });
      const hash =
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      const result = <String, Object?>{
        'state': 'completed',
        'recordingSha256': hash,
      };
      await repository.commitRecording(
        sessionId: sessionId,
        recordingId: recordingId,
        recordingSha256: hash,
        partialCapture: false,
        idempotencyKey: 'stop-abcdef123456',
        result: result,
        nowMs: 40,
      );
      await repository.commitRecording(
        sessionId: sessionId,
        recordingId: recordingId,
        recordingSha256: hash,
        partialCapture: false,
        idempotencyKey: 'stop-abcdef123456',
        result: result,
        nowMs: 41,
      );

      final session = await repository.findSession(sessionId);
      expect(session?.state, 'completed');
      expect(session?.recordingId, recordingId);
      expect(session?.recordingSha256, hash);
      expect(await repository.recoverableSessions(), isEmpty);

      const partialSessionId = 'session-partial123456';
      await repository.beginSession(
        sessionId: partialSessionId,
        workspacePath: '${root.path}/$partialSessionId',
        nowMs: 50,
      );
      final partialRecordingId = await database.insert(
        'recordings',
        <String, Object?>{
          'file_path': '${root.path}/partial.caf',
          'session_id': partialSessionId,
          'duration_ms': 4000,
          'created_at_ms': 60,
        },
      );
      await repository.commitRecording(
        sessionId: partialSessionId,
        recordingId: partialRecordingId,
        recordingSha256: hash,
        partialCapture: true,
        idempotencyKey: 'keep-partial123456',
        result: const <String, Object?>{'state': 'partial_capture'},
        nowMs: 70,
      );
      expect(
        (await repository.findSession(partialSessionId))?.state,
        'partial_capture',
      );
      expect(await repository.recoverableSessions(), isEmpty);
    },
  );

  test(
    'timeline rollback and idempotency-key intent drift fail closed',
    () async {
      const sessionId = 'session-drift123456';
      await repository.beginSession(
        sessionId: sessionId,
        workspacePath: '${root.path}/$sessionId',
        nowMs: 10,
      );
      await repository.saveSnapshotAndReceipt(
        sessionId: sessionId,
        state: 'recording',
        captureTimelineMs: 100,
        partialCapture: false,
        action: 'start',
        idempotencyKey: 'start-drift123456',
        result: const <String, Object?>{'state': 'recording'},
        nowMs: 20,
      );
      await expectLater(
        repository.saveSnapshotAndReceipt(
          sessionId: sessionId,
          state: 'recording',
          captureTimelineMs: 99,
          partialCapture: false,
          action: 'start',
          idempotencyKey: 'start-drift123456',
          result: const <String, Object?>{'state': 'recording'},
          nowMs: 21,
        ),
        throwsStateError,
      );
      await expectLater(
        repository.saveSnapshotAndReceipt(
          sessionId: sessionId,
          state: 'recording',
          captureTimelineMs: 100,
          partialCapture: false,
          action: 'start',
          idempotencyKey: 'start-drift123456',
          result: const <String, Object?>{'state': 'paused'},
          nowMs: 22,
        ),
        throwsStateError,
      );
    },
  );
}
