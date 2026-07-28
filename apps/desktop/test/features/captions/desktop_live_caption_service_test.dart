import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:voice2text_desktop/features/captions/desktop_live_caption_service.dart';
import 'package:voice2text_desktop/features/captions/live_caption_models.dart';
import 'package:voice2text_desktop/features/captions/live_caption_repository.dart';
import 'package:voice2text_desktop/features/captions/live_caption_worker_client.dart';

void main() {
  sqfliteFfiInit();

  test('service persists utterance and durable offset before flush', () async {
    final root = await Directory.systemTemp.createTemp('caption-service-');
    addTearDown(() => root.delete(recursive: true));
    final database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => root.path,
      databaseName: 'test.db',
    );
    addTearDown(() async => (await database.database).close());
    const sessionId = 'session-caption-service';
    await DesktopCaptureRepository(
      database,
    ).beginSession(sessionId: sessionId, workspacePath: root.path, nowMs: 1);
    final captionDirectory = Directory('${root.path}/caption');
    await captionDirectory.create();
    await File(
      '${captionDirectory.path}/live-caption.pcmspool',
    ).writeAsBytes(List<int>.filled(32000, 0));
    final worker = _Worker();
    final service = DesktopLiveCaptionService(
      repository: LiveCaptionRepository(database: database),
      workerFactory: (_) => worker,
      pollInterval: const Duration(milliseconds: 5),
      clock: () => DateTime.fromMillisecondsSinceEpoch(10),
    );
    addTearDown(service.dispose);

    final session = await service.start(
      sessionId: sessionId,
      sessionRoot: root.path,
      modelSha256: _hash,
    );
    await worker.utteranceCommitted.future.timeout(const Duration(seconds: 1));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(await service.flushAndClose(), isTrue);

    final db = await database.database;
    final segments = await db.query(
      'transcript_segments',
      where: 'generation_id = ?',
      whereArgs: <Object?>[session.generationId],
    );
    expect(segments, hasLength(1));
    expect(segments.single['text'], '草稿');
    final durable = await LiveCaptionRepository(
      database: database,
    ).find(sessionId);
    expect(durable?.workerOffsetBytes, 32000);
    expect(durable?.state, LiveCaptionSessionState.flushed);
  });
}

const String _hash =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class _Worker implements LiveCaptionWorkerPort {
  final StreamController<Map<String, Object?>> _events =
      StreamController<Map<String, Object?>>.broadcast();
  final Completer<void> utteranceCommitted = Completer<void>();
  bool emitted = false;

  @override
  Stream<Map<String, Object?>> get events => _events.stream;

  @override
  Future<void> start() async {}

  @override
  Future<Map<String, Object?>> openSession({
    required String sessionId,
    required int generationId,
    required int offsetBytes,
    required int firstSequence,
  }) async {
    return <String, Object?>{
      'schemaVersion': 1,
      'type': 'sessionReady',
      'sessionId': sessionId,
      'generationId': generationId,
      'offsetBytes': offsetBytes,
      'modelSha256': _hash,
    };
  }

  @override
  Future<Map<String, Object?>> poll({
    required String sessionId,
    required int generationId,
  }) async {
    if (!emitted) {
      emitted = true;
      _events.add(<String, Object?>{
        'schemaVersion': 1,
        'type': 'utterance',
        'sessionId': sessionId,
        'generationId': generationId,
        'sequence': 1,
        'startSeconds': 0.1,
        'endSeconds': 0.9,
        'text': '草稿',
        'language': 'zh',
        'offsetBytes': 32000,
      });
      scheduleMicrotask(utteranceCommitted.complete);
    }
    return <String, Object?>{
      'schemaVersion': 1,
      'type': 'pollComplete',
      'sessionId': sessionId,
      'generationId': generationId,
      'offsetBytes': 32000,
      'backlogBytes': 0,
    };
  }

  @override
  Future<Map<String, Object?>> flush({
    required String sessionId,
    required int generationId,
  }) async {
    return <String, Object?>{
      'schemaVersion': 1,
      'type': 'sessionComplete',
      'sessionId': sessionId,
      'generationId': generationId,
      'offsetBytes': 32000,
    };
  }

  @override
  Future<void> close() async {
    await _events.close();
  }
}
