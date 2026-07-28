import 'dart:async';
import 'dart:io';

import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;

import 'live_caption_models.dart';
import 'live_caption_repository.dart';
import 'live_caption_worker_client.dart';

typedef LiveCaptionWorkerFactory =
    LiveCaptionWorkerPort Function(String sessionRoot);

class DesktopLiveCaptionService implements MeetingDraftHandoffPort {
  DesktopLiveCaptionService({
    required LiveCaptionRepository repository,
    required LiveCaptionWorkerFactory workerFactory,
    DateTime Function()? clock,
    this.pollInterval = const Duration(milliseconds: 250),
  }) : _repository = repository,
       _workerFactory = workerFactory,
       _clock = clock ?? DateTime.now;

  final LiveCaptionRepository _repository;
  final LiveCaptionWorkerFactory _workerFactory;
  final DateTime Function() _clock;
  final Duration pollInterval;
  final StreamController<LiveCaptionUtterance> _utterances =
      StreamController<LiveCaptionUtterance>.broadcast();
  final StreamController<String> _failures =
      StreamController<String>.broadcast();
  LiveCaptionWorkerPort? _worker;
  LiveCaptionSessionRecord? _session;
  StreamSubscription<Map<String, Object?>>? _subscription;
  Timer? _pollTimer;
  Future<void> _eventSerial = Future<void>.value();
  bool _polling = false;
  bool _closing = false;
  String? _sessionRoot;

  LiveCaptionSessionRecord? get activeSession => _session;
  Stream<LiveCaptionUtterance> get utterances => _utterances.stream;
  Stream<String> get failures => _failures.stream;
  int get backlogBytes => _backlogBytes;
  int _backlogBytes = 0;

  Future<LiveCaptionSessionRecord> start({
    required String sessionId,
    required String sessionRoot,
    required String modelSha256,
    String profileId = senseVoiceU18ControlProfile,
  }) async {
    if (_worker != null) {
      throw StateError('A live-caption worker is already active');
    }
    final root = Directory(sessionRoot);
    final spool = File(p.join(root.path, liveCaptionSpoolRelativePath));
    await _requireContainedSpool(root, spool);
    final session = await _repository.createOrResume(
      sessionId: sessionId,
      workspacePath: root.path,
      modelSha256: modelSha256,
      profileId: profileId,
      nowMs: _nowMs,
    );
    final spoolBytes = await spool.length();
    if (spoolBytes < session.workerOffsetBytes ||
        spoolBytes % (liveCaptionSampleRate ~/ 10 * 2) != 0) {
      await _repository.markState(
        sessionId,
        LiveCaptionSessionState.failed,
        nowMs: _nowMs,
        errorCode: 'SPOOL_OFFSET_INVALID',
      );
      throw StateError('Live-caption spool is not frame aligned');
    }
    final worker = _workerFactory(root.path);
    _session = session;
    _sessionRoot = root.path;
    _worker = worker;
    _subscription = worker.events.listen(
      _handleEvent,
      onError: (Object error, StackTrace stackTrace) {
        unawaited(_degrade('WORKER_EVENT_FAILED'));
      },
    );
    try {
      await worker.start();
      await worker.openSession(
        sessionId: sessionId,
        generationId: session.generationId,
        offsetBytes: session.workerOffsetBytes,
        firstSequence: session.lastSequence + 1,
      );
      await _repository.markState(
        sessionId,
        LiveCaptionSessionState.running,
        nowMs: _nowMs,
      );
      _session = (await _repository.find(sessionId))!;
      _pollTimer = Timer.periodic(pollInterval, (_) => unawaited(_poll()));
      return _session!;
    } catch (_) {
      await _degrade('WORKER_START_FAILED');
      rethrow;
    }
  }

  Future<void> pause() async {
    final session = _session;
    if (session == null || _closing) return;
    _pollTimer?.cancel();
    await _repository.markState(
      session.sessionId,
      LiveCaptionSessionState.paused,
      nowMs: _nowMs,
    );
    _session = (await _repository.find(session.sessionId))!;
  }

  Future<void> resume() async {
    final session = _session;
    if (session == null || _closing) return;
    await _repository.markState(
      session.sessionId,
      LiveCaptionSessionState.running,
      nowMs: _nowMs,
    );
    _session = (await _repository.find(session.sessionId))!;
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(pollInterval, (_) => unawaited(_poll()));
  }

  Future<void> restart() async {
    final session = _session;
    final rootPath = _sessionRoot;
    if (session == null || rootPath == null || _closing) {
      throw StateError('No live-caption session can be restarted');
    }
    _pollTimer?.cancel();
    await _subscription?.cancel();
    await _worker?.close();
    _subscription = null;
    _worker = null;
    final root = Directory(rootPath);
    final spool = File(p.join(root.path, liveCaptionSpoolRelativePath));
    await _requireContainedSpool(root, spool);
    final spoolBytes = await spool.length();
    if (spoolBytes < session.workerOffsetBytes ||
        spoolBytes % (liveCaptionSampleRate ~/ 10 * 2) != 0) {
      throw StateError('Live-caption spool is not frame aligned');
    }
    final worker = _workerFactory(root.path);
    _worker = worker;
    _subscription = worker.events.listen(
      _handleEvent,
      onError: (Object error, StackTrace stackTrace) {
        unawaited(_degrade('WORKER_EVENT_FAILED'));
      },
    );
    try {
      await worker.start();
      await worker.openSession(
        sessionId: session.sessionId,
        generationId: session.generationId,
        offsetBytes: session.workerOffsetBytes,
        firstSequence: session.lastSequence + 1,
      );
      await _repository.markState(
        session.sessionId,
        LiveCaptionSessionState.running,
        nowMs: _nowMs,
      );
      _session = (await _repository.find(session.sessionId))!;
      _pollTimer = Timer.periodic(pollInterval, (_) => unawaited(_poll()));
    } catch (_) {
      await _degrade('WORKER_RESTART_FAILED');
      rethrow;
    }
  }

  Future<void> attachCommittedRecording({
    required int recordingId,
    required String recordingPath,
  }) async {
    final session = _session;
    if (session == null) return;
    await _repository.attachCommittedRecording(
      sessionId: session.sessionId,
      recordingId: recordingId,
      recordingPath: recordingPath,
      nowMs: _nowMs,
    );
    _session = (await _repository.find(session.sessionId))!;
  }

  @override
  Future<void> attachCommittedCapture(CommittedMeetingCapture capture) {
    final session = _session;
    if (session == null || session.sessionId != capture.sessionId) {
      throw StateError('Committed capture does not match live captions');
    }
    return attachCommittedRecording(
      recordingId: capture.recordingId,
      recordingPath: capture.recordingPath,
    );
  }

  /// Flush failures degrade captions only. The caller can still enqueue the
  /// post-meeting formal job because authority audio was committed first.
  @override
  Future<bool> flushAndClose() async {
    final worker = _worker;
    final session = _session;
    if (worker == null || session == null) return true;
    _closing = true;
    _pollTimer?.cancel();
    await _repository.markState(
      session.sessionId,
      LiveCaptionSessionState.flushing,
      nowMs: _nowMs,
    );
    try {
      final complete = await worker.flush(
        sessionId: session.sessionId,
        generationId: session.generationId,
      );
      await _saveOffset(complete);
      await _eventSerial;
      await worker.close();
      await _repository.markFlushed(session.sessionId, nowMs: _nowMs);
      await _deleteDisposableSpool();
      _session = (await _repository.find(session.sessionId))!;
      return true;
    } catch (_) {
      await _degrade('WORKER_FLUSH_FAILED');
      return false;
    } finally {
      await _subscription?.cancel();
      _subscription = null;
      _worker = null;
      _pollTimer = null;
      _closing = false;
    }
  }

  Future<void> dispose() async {
    _pollTimer?.cancel();
    await _subscription?.cancel();
    await _worker?.close();
    await _utterances.close();
    await _failures.close();
    _worker = null;
    _session = null;
  }

  Future<void> _poll() async {
    final worker = _worker;
    final session = _session;
    if (_polling || _closing || worker == null || session == null) return;
    _polling = true;
    try {
      final event = await worker.poll(
        sessionId: session.sessionId,
        generationId: session.generationId,
      );
      await _saveOffset(event);
      final backlog = event['backlogBytes'];
      _backlogBytes = backlog is num ? backlog.toInt() : 0;
      if (backlog is num && backlog > liveCaptionSampleRate * 2 * 30) {
        await _degrade('CAPTION_BACKLOG_EXCEEDED');
      }
    } catch (_) {
      await _degrade('WORKER_POLL_FAILED');
    } finally {
      _polling = false;
    }
  }

  void _handleEvent(Map<String, Object?> event) {
    if (event['type'] != 'utterance') return;
    final session = _session;
    if (session == null) return;
    _eventSerial = _eventSerial.then((_) async {
      try {
        final utterance = LiveCaptionUtterance.fromWorkerEvent(
          event,
          generationId: session.generationId,
          modelSha256: session.modelSha256,
        );
        await _repository.appendUtterance(utterance, nowMs: _nowMs);
        if (!_utterances.isClosed) _utterances.add(utterance);
        _session = (await _repository.find(session.sessionId))!;
      } catch (_) {
        await _degrade('UTTERANCE_REJECTED');
      }
    });
  }

  Future<void> _saveOffset(Map<String, Object?> event) async {
    final session = _session;
    final offset = event['offsetBytes'];
    if (session == null || offset is! num) {
      throw const FormatException('Worker completion omitted offset');
    }
    await _repository.saveWorkerOffset(
      sessionId: session.sessionId,
      workerOffsetBytes: offset.toInt(),
      nowMs: _nowMs,
    );
    _session = (await _repository.find(session.sessionId))!;
  }

  Future<void> _degrade(String code) async {
    final session = _session;
    if (session == null) return;
    _pollTimer?.cancel();
    try {
      await _repository.markState(
        session.sessionId,
        LiveCaptionSessionState.failed,
        nowMs: _nowMs,
        errorCode: code,
      );
      _session = (await _repository.find(session.sessionId))!;
    } catch (_) {
      // Capture authority is intentionally independent from caption failures.
    }
    try {
      await _worker?.close();
    } catch (_) {
      // The durable offset and accepted utterances remain the recovery point.
    }
    await _subscription?.cancel();
    _subscription = null;
    _worker = null;
    if (!_failures.isClosed) _failures.add(code);
  }

  Future<void> _deleteDisposableSpool() async {
    final root = _sessionRoot;
    if (root == null || _session?.recordingId == null) return;
    final spool = File(p.join(root, liveCaptionSpoolRelativePath));
    if (await spool.exists()) await spool.delete();
  }

  static Future<void> _requireContainedSpool(Directory root, File spool) async {
    final resolvedRoot = await root.resolveSymbolicLinks();
    final resolvedSpool = await spool.resolveSymbolicLinks();
    final prefix = resolvedRoot.endsWith(Platform.pathSeparator)
        ? resolvedRoot
        : '$resolvedRoot${Platform.pathSeparator}';
    if (!resolvedSpool.startsWith(prefix) || !await spool.exists()) {
      throw StateError('Live-caption spool escaped its capture session');
    }
  }

  int get _nowMs => _clock().millisecondsSinceEpoch;
}
