import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_service.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_workspace.dart';

void main() {
  sqfliteFfiInit();

  late Directory root;
  late AppDatabase database;
  late DesktopCaptureRepository repository;
  late DesktopCaptureWorkspace workspace;
  late _FakeCapturePort port;
  late DesktopCaptureService service;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('capture-service-');
    database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'capture.db',
    );
    repository = DesktopCaptureRepository(database);
    workspace = DesktopCaptureWorkspace(Directory('${root.path}/sessions'));
    port = _FakeCapturePort();
    service = DesktopCaptureService(
      port: port,
      repository: repository,
      workspace: workspace,
      recovery: DesktopCaptureRecovery(
        repository: repository,
        workspace: workspace,
        clock: () => DateTime.fromMillisecondsSinceEpoch(100),
      ),
      clock: () => DateTime.fromMillisecondsSinceEpoch(100),
    );
  });

  tearDown(() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  });

  test('start and pause return persistent idempotent receipts', () async {
    const sessionId = 'session-123456789abc';
    final first = await service.start(
      sessionId: sessionId,
      idempotencyKey: 'start-123456789abc',
      minimumFreeBytes: 1024,
    );
    final duplicate = await service.start(
      sessionId: sessionId,
      idempotencyKey: 'start-123456789abc',
      minimumFreeBytes: 1024,
    );
    expect(first.state, DesktopCaptureSessionState.recording);
    expect(duplicate.state, DesktopCaptureSessionState.recording);
    expect(port.startCalls, 1);

    await service.pause(
      sessionId: sessionId,
      idempotencyKey: 'pause-123456789abc',
    );
    await service.pause(
      sessionId: sessionId,
      idempotencyKey: 'pause-123456789abc',
    );
    expect(port.pauseCalls, 1);
    expect((await repository.findSession(sessionId))?.state, 'paused');
  });

  test('stop validates journal and atomically commits one recording', () async {
    const sessionId = 'session-abcdef123456';
    await service.start(
      sessionId: sessionId,
      idempotencyKey: 'start-abcdef123456',
      minimumFreeBytes: 1024,
    );

    final first = await service.stop(
      sessionId: sessionId,
      idempotencyKey: 'stop-abcdef123456',
      displayName: 'Captured meeting',
    );
    final duplicate = await service.stop(
      sessionId: sessionId,
      idempotencyKey: 'stop-abcdef123456',
      displayName: 'Captured meeting',
    );

    expect(first.state, DesktopCaptureSessionState.completed);
    expect(first.recordingId, isNotNull);
    expect(first.recordingSha256, hasLength(64));
    expect(duplicate.recordingId, first.recordingId);
    expect(port.stopCalls, 1);
    final sql = await database.database;
    expect(
      (await sql.rawQuery(
        'SELECT COUNT(*) AS count FROM recordings',
      )).single['count'],
      1,
    );
    expect(
      (await sql.rawQuery(
        'SELECT COUNT(*) AS count FROM meeting_assets',
      )).single['count'],
      3,
    );
    expect((await repository.findSession(sessionId))?.state, 'completed');
  });
}

class _FakeCapturePort implements DesktopCapturePort {
  int startCalls = 0;
  int pauseCalls = 0;
  int stopCalls = 0;
  String? _sessionId;
  String? _sessionRoot;

  @override
  Stream<DesktopCaptureSessionSnapshot> get snapshots =>
      const Stream<DesktopCaptureSessionSnapshot>.empty();

  @override
  Stream<DesktopCaptureMenuAction> get menuActions =>
      const Stream<DesktopCaptureMenuAction>.empty();

  @override
  Future<DesktopCapturePreflight> preflight({
    required String sessionRoot,
    required int minimumFreeBytes,
    required bool captionModelAvailable,
    bool requestPermissions = false,
  }) async {
    return const DesktopCapturePreflight(
      minimumMacosVersion: '14.2',
      systemAudioPermission: DesktopCapturePermissionState.granted,
      microphonePermission: DesktopCapturePermissionState.granted,
      microphones: <DesktopCaptureDevice>[],
      availableBytes: 1 << 40,
      requiredBytes: 1024,
      captionModelAvailable: false,
      canStart: true,
      blockingReasons: <String>[],
    );
  }

  @override
  Future<DesktopCaptureSessionSnapshot> start(
    DesktopCaptureStartRequest request,
  ) async {
    startCalls += 1;
    _sessionId = request.sessionId;
    _sessionRoot = request.sessionRoot;
    await _writeNativeJournal(
      Directory(request.sessionRoot),
      sessionId: request.sessionId,
      state: 'recording',
    );
    return _snapshot(DesktopCaptureSessionState.recording, 0);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> pause({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    pauseCalls += 1;
    return _snapshot(DesktopCaptureSessionState.paused, 1000);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> resume({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    return _snapshot(DesktopCaptureSessionState.recording, 1000);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> stop({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    stopCalls += 1;
    await _writeNativeJournal(
      Directory(_sessionRoot!),
      sessionId: sessionId,
      state: 'completed',
    );
    return _snapshot(DesktopCaptureSessionState.completed, 5000);
  }

  @override
  Future<List<DesktopCaptureSessionSnapshot>> recoverableSessions({
    required String captureRoot,
  }) async {
    return const <DesktopCaptureSessionSnapshot>[];
  }

  DesktopCaptureSessionSnapshot _snapshot(
    DesktopCaptureSessionState state,
    int timelineMs,
  ) {
    return DesktopCaptureSessionSnapshot(
      sessionId: _sessionId!,
      state: state,
      captureTimelineMs: timelineMs,
      systemAudioHealthy: state == DesktopCaptureSessionState.recording,
      microphoneHealthy: state == DesktopCaptureSessionState.recording,
      partialCapture: false,
      finalizedChunkCount: state == DesktopCaptureSessionState.completed
          ? 2
          : 0,
      eventCount: 0,
    );
  }
}

Future<void> _writeNativeJournal(
  Directory root, {
  required String sessionId,
  required String state,
}) async {
  final systemBytes = <int>[1, 2, 3, 4];
  final microphoneBytes = <int>[5, 6, 7];
  final system = File('${root.path}/system/chunk-000000.caf');
  final microphone = File('${root.path}/microphone/chunk-000000.caf');
  await system.parent.create(recursive: true);
  await microphone.parent.create(recursive: true);
  await system.writeAsBytes(systemBytes, flush: true);
  await microphone.writeAsBytes(microphoneBytes, flush: true);
  final document = <String, Object?>{
    'schema': 'desktop-capture-session/v1',
    'sessionId': sessionId,
    'state': state,
    'captureTimelineMs': state == 'completed' ? 5000 : 0,
    'createdAtMs': 1,
    'updatedAtMs': 2,
    'tracks': <Object?>[
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
      _chunk('system_audio', 'system/chunk-000000.caf', systemBytes),
      _chunk('microphone', 'microphone/chunk-000000.caf', microphoneBytes),
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
  await File(
    '${root.path}/journal.json',
  ).writeAsString(jsonEncode(document), flush: true);
}

Map<String, Object?> _chunk(String track, String path, List<int> bytes) {
  return <String, Object?>{
    'track': track,
    'sequence': 0,
    'startMs': 0,
    'endMs': 5000,
    'relativePath': path,
    'bytes': bytes.length,
    'sha256': sha256.convert(bytes).toString(),
    'finalized': true,
  };
}
