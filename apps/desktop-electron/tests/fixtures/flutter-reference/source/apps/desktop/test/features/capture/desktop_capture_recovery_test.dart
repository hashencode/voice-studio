import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_workspace.dart';

void main() {
  sqfliteFfiInit();

  late Directory root;
  late AppDatabase database;
  late DesktopCaptureRepository repository;
  late DesktopCaptureWorkspace workspace;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('capture-recovery-');
    database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'capture.db',
    );
    repository = DesktopCaptureRepository(database);
    workspace = DesktopCaptureWorkspace(Directory('${root.path}/sessions'));
  });

  tearDown(() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  });

  test('valid journal is reconciled idempotently as recoverable', () async {
    const sessionId = 'session-123456789abc';
    final directory = await workspace.createSession(sessionId);
    await _writeJournal(directory, sessionId: sessionId);
    final recovery = DesktopCaptureRecovery(
      repository: repository,
      workspace: workspace,
      clock: () => DateTime.fromMillisecondsSinceEpoch(100),
    );

    final first = await recovery.reconcileJournals();
    final second = await recovery.reconcileJournals();

    expect(first.single.state, 'recoverable');
    expect(first.single.validatedChunkCount, 2);
    expect(second.single.state, 'recoverable');
    final session = await repository.findSession(sessionId);
    expect(session?.captureTimelineMs, 5000);
    final sql = await database.database;
    expect(
      (await sql.rawQuery(
        'SELECT COUNT(*) AS count FROM desktop_capture_chunks',
      )).single['count'],
      2,
    );
    expect(
      (await sql.rawQuery(
        'SELECT COUNT(*) AS count '
        'FROM desktop_capture_command_receipts',
      )).single['count'],
      1,
    );
  });

  test('hash drift fails closed without deleting authority files', () async {
    const sessionId = 'session-corrupt12345';
    final directory = await workspace.createSession(sessionId);
    await _writeJournal(directory, sessionId: sessionId);
    final systemChunk = File('${directory.path}/system/chunk-000000.caf');
    await systemChunk.writeAsBytes(<int>[9, 9, 9], flush: true);
    final recovery = DesktopCaptureRecovery(
      repository: repository,
      workspace: workspace,
      clock: () => DateTime.fromMillisecondsSinceEpoch(200),
    );

    final result = (await recovery.reconcileJournals()).single;

    expect(result.state, 'failed');
    expect(result.error, contains('chunk.'));
    expect(await systemChunk.exists(), isTrue);
    expect((await repository.findSession(sessionId))?.state, 'failed');
  });

  test(
    'recovery advances a stale journal timeline to the last safe chunk',
    () async {
      const sessionId = 'session-staletimeline';
      final directory = await workspace.createSession(sessionId);
      await _writeJournal(
        directory,
        sessionId: sessionId,
        captureTimelineMs: 5000,
        chunkEndMs: 6000,
      );
      await repository.beginSession(
        sessionId: sessionId,
        workspacePath: directory.path,
        nowMs: 10,
      );
      await repository.saveSnapshotAndReceipt(
        sessionId: sessionId,
        state: 'recording',
        captureTimelineMs: 5003,
        partialCapture: false,
        action: 'start',
        idempotencyKey: 'start-staletimeline',
        result: const <String, Object?>{'state': 'recording'},
        nowMs: 20,
      );
      final recovery = DesktopCaptureRecovery(
        repository: repository,
        workspace: workspace,
        clock: () => DateTime.fromMillisecondsSinceEpoch(300),
      );

      final result = (await recovery.reconcileJournals()).single;

      expect(result.state, 'recoverable');
      expect(result.error, isNull);
      expect(result.captureTimelineMs, 6000);
      expect(result.lastSafeChunkMs, 6000);
      final session = await repository.findSession(sessionId);
      expect(session?.state, 'recoverable');
      expect(session?.captureTimelineMs, 6000);
    },
  );

  test(
    'microphone-only journal is valid authority, not partial capture',
    () async {
      const sessionId = 'session-microphone12';
      final directory = await workspace.createSession(sessionId);
      await _writeJournal(
        directory,
        sessionId: sessionId,
        microphoneOnly: true,
      );
      final recovery = DesktopCaptureRecovery(
        repository: repository,
        workspace: workspace,
        clock: () => DateTime.fromMillisecondsSinceEpoch(300),
      );

      final result = (await recovery.reconcileJournals()).single;

      expect(result.state, 'recoverable');
      expect(result.validatedChunkCount, 1);
      expect(result.healthyTrackCount, 1);
      final sql = await database.database;
      expect(
        (await sql.rawQuery(
          'SELECT COUNT(*) AS count FROM desktop_capture_tracks',
        )).single['count'],
        1,
      );
    },
  );

  test('committed partial capture is not offered again after restart', () async {
    const sessionId = 'session-keptpartial1';
    final directory = await workspace.createSession(sessionId);
    await _writeJournal(directory, sessionId: sessionId);
    final sql = await database.database;
    await repository.beginSession(
      sessionId: sessionId,
      workspacePath: directory.path,
      nowMs: 10,
    );
    final recordingId = await sql.insert('recordings', <String, Object?>{
      'file_path': '${directory.path}/journal.json',
      'session_id': sessionId,
      'duration_ms': 5000,
      'created_at_ms': 20,
    });
    await repository.commitRecording(
      sessionId: sessionId,
      recordingId: recordingId,
      recordingSha256:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      partialCapture: true,
      idempotencyKey: 'keep-keptpartial1',
      result: const <String, Object?>{'state': 'partial_capture'},
      nowMs: 30,
    );
    await repository.setRecoveryDisposition(
      sessionId: sessionId,
      disposition: 'kept_partial',
      nowMs: 40,
    );
    final recovery = DesktopCaptureRecovery(
      repository: repository,
      workspace: workspace,
      clock: () => DateTime.fromMillisecondsSinceEpoch(100),
    );

    final result = (await recovery.reconcileJournals()).single;

    expect(result.state, 'completed');
    expect(result.validatedChunkCount, 0);
    expect(await repository.recoverableSessions(), isEmpty);
  });
}

Future<void> _writeJournal(
  Directory root, {
  required String sessionId,
  bool microphoneOnly = false,
  int captureTimelineMs = 5000,
  int chunkEndMs = 5000,
}) async {
  final system = File('${root.path}/system/chunk-000000.caf');
  final microphone = File('${root.path}/microphone/chunk-000000.caf');
  if (!microphoneOnly) {
    await system.parent.create(recursive: true);
    await system.writeAsBytes(<int>[1, 2, 3, 4], flush: true);
  }
  await microphone.parent.create(recursive: true);
  await microphone.writeAsBytes(<int>[5, 6, 7], flush: true);
  final document = <String, Object?>{
    'schema': 'desktop-capture-session/v1',
    'sessionId': sessionId,
    'captureMode': microphoneOnly ? 'microphone_only' : 'dual_track',
    'state': 'recording',
    'captureTimelineMs': captureTimelineMs,
    'createdAtMs': 1,
    'updatedAtMs': 2,
    'tracks': <Object?>[
      if (!microphoneOnly)
        <String, Object?>{
          'kind': 'system_audio',
          'healthy': true,
          'sampleRate': 48000,
          'channels': 2,
          'format': 'pcm-f32le',
        },
      <String, Object?>{
        'kind': 'microphone',
        'healthy': true,
        'sampleRate': 48000,
        'channels': 1,
        'format': 'pcm-f32le',
      },
    ],
    'chunks': <Object?>[
      if (!microphoneOnly)
        _chunk(
          track: 'system_audio',
          path: 'system/chunk-000000.caf',
          bytes: <int>[1, 2, 3, 4],
          endMs: chunkEndMs,
        ),
      _chunk(
        track: 'microphone',
        path: 'microphone/chunk-000000.caf',
        bytes: <int>[5, 6, 7],
        endMs: chunkEndMs,
      ),
    ],
    'events': <Object?>[],
    'spool': <String, Object?>{
      'relativePath': 'caption/live-caption.pcmspool',
      'format': 's16le',
      'sampleRate': 16000,
      'channels': 1,
      'frameDurationMs': 100,
      'disposable': true,
    },
    'recordingId': null,
    'recordingSha256': null,
  };
  await File('${root.path}/journal.json').writeAsString(
    const JsonEncoder.withIndent('  ').convert(document),
    flush: true,
  );
}

Map<String, Object?> _chunk({
  required String track,
  required String path,
  required List<int> bytes,
  int endMs = 5000,
}) {
  return <String, Object?>{
    'track': track,
    'sequence': 0,
    'startMs': 0,
    'endMs': endMs,
    'relativePath': path,
    'bytes': bytes.length,
    'sha256': sha256.convert(bytes).toString(),
    'finalized': true,
  };
}
