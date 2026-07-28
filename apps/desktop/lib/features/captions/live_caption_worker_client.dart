import 'dart:async';
import 'dart:convert';
import 'dart:io';

const int maximumLiveCaptionWorkerLineBytes = 1024 * 1024;
const int maximumLiveCaptionEventsPerSecond = 50;

class LiveCaptionWorkerConfiguration {
  const LiveCaptionWorkerConfiguration({
    required this.executable,
    required this.arguments,
    required this.sessionRoot,
    required this.modelSha256,
  });

  final String executable;
  final List<String> arguments;
  final String sessionRoot;
  final String modelSha256;
}

class LiveCaptionWorkerFailure implements Exception {
  const LiveCaptionWorkerFailure(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'LiveCaptionWorkerFailure($code, $message)';
}

typedef LiveCaptionProcessStarter =
    Future<Process> Function(
      String executable,
      List<String> arguments, {
      required Map<String, String> environment,
      required bool includeParentEnvironment,
    });

abstract interface class LiveCaptionWorkerPort {
  Stream<Map<String, Object?>> get events;

  Future<void> start();

  Future<Map<String, Object?>> openSession({
    required String sessionId,
    required int generationId,
    required int offsetBytes,
    required int firstSequence,
  });

  Future<Map<String, Object?>> poll({
    required String sessionId,
    required int generationId,
  });

  Future<Map<String, Object?>> flush({
    required String sessionId,
    required int generationId,
  });

  Future<void> close();
}

class LiveCaptionWorkerClient implements LiveCaptionWorkerPort {
  LiveCaptionWorkerClient({
    required LiveCaptionWorkerConfiguration configuration,
    LiveCaptionProcessStarter? processStarter,
  }) : _configuration = configuration,
       _processStarter = processStarter ?? _startProcess;

  final LiveCaptionWorkerConfiguration _configuration;
  final LiveCaptionProcessStarter _processStarter;
  final StreamController<Map<String, Object?>> _events =
      StreamController<Map<String, Object?>>.broadcast();
  final Map<String, Completer<Map<String, Object?>>> _waiters =
      <String, Completer<Map<String, Object?>>>{};
  Process? _process;
  StreamSubscription<String>? _stdoutSubscription;
  StreamSubscription<List<int>>? _stderrSubscription;
  final List<int> _stderr = <int>[];
  Future<void> _serial = Future<void>.value();
  int _rateWindowSecond = -1;
  int _rateWindowCount = 0;
  bool _closed = false;

  @override
  Stream<Map<String, Object?>> get events => _events.stream;

  @override
  Future<void> start() async {
    if (_process != null || _closed) {
      throw StateError('Live-caption worker client cannot be restarted');
    }
    final ready = _expect('ready');
    final process = await _processStarter(
      _configuration.executable,
      _configuration.arguments,
      environment: const <String, String>{'LANG': 'C.UTF-8'},
      includeParentEnvironment: false,
    );
    _process = process;
    _stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_handleLine, onError: _fail, onDone: _stdoutDone);
    _stderrSubscription = process.stderr.listen((bytes) {
      if (_stderr.length < 64 * 1024) {
        _stderr.addAll(bytes.take(64 * 1024 - _stderr.length));
      }
    });
    unawaited(
      process.exitCode.then((code) {
        if (!_closed && code != 0) {
          _fail(
            LiveCaptionWorkerFailure(
              'WORKER_EXITED',
              'Live-caption worker exited with code $code',
            ),
          );
        }
      }),
    );
    await ready.timeout(const Duration(seconds: 30));
  }

  @override
  Future<Map<String, Object?>> openSession({
    required String sessionId,
    required int generationId,
    required int offsetBytes,
    required int firstSequence,
  }) {
    return _runSerialized(() async {
      final response = _expect('sessionReady');
      _send(<String, Object?>{
        'schemaVersion': 1,
        'type': 'openSession',
        'sessionId': sessionId,
        'generationId': generationId,
        'spoolRelativePath': 'caption/live-caption.pcmspool',
        'offsetBytes': offsetBytes,
        'firstSequence': firstSequence,
      });
      final event = await response.timeout(const Duration(seconds: 10));
      _requireSession(event, sessionId, generationId);
      if (event['modelSha256'] != _configuration.modelSha256) {
        throw const LiveCaptionWorkerFailure(
          'MODEL_HASH_MISMATCH',
          'Live-caption worker reported a different model',
        );
      }
      return event;
    });
  }

  @override
  Future<Map<String, Object?>> poll({
    required String sessionId,
    required int generationId,
  }) {
    return _control(
      type: 'poll',
      responseType: 'pollComplete',
      sessionId: sessionId,
      generationId: generationId,
      timeout: const Duration(seconds: 30),
    );
  }

  @override
  Future<Map<String, Object?>> flush({
    required String sessionId,
    required int generationId,
  }) {
    return _control(
      type: 'flush',
      responseType: 'sessionComplete',
      sessionId: sessionId,
      generationId: generationId,
      timeout: const Duration(minutes: 10),
    );
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    final process = _process;
    if (process != null) {
      try {
        _send(const <String, Object?>{'schemaVersion': 1, 'type': 'shutdown'});
      } catch (_) {
        process.kill();
      }
      try {
        await process.exitCode.timeout(const Duration(seconds: 5));
      } on TimeoutException {
        process.kill();
      }
    }
    _closed = true;
    await _stdoutSubscription?.cancel();
    await _stderrSubscription?.cancel();
    _completeWaiters(
      const LiveCaptionWorkerFailure('WORKER_CLOSED', 'Worker was closed'),
    );
    await _events.close();
  }

  Future<Map<String, Object?>> _control({
    required String type,
    required String responseType,
    required String sessionId,
    required int generationId,
    required Duration timeout,
  }) {
    return _runSerialized(() async {
      final response = _expect(responseType);
      _send(<String, Object?>{
        'schemaVersion': 1,
        'type': type,
        'sessionId': sessionId,
      });
      final event = await response.timeout(timeout);
      _requireSession(event, sessionId, generationId);
      return event;
    });
  }

  Future<T> _runSerialized<T>(Future<T> Function() operation) {
    final completer = Completer<T>();
    _serial = _serial.then((_) async {
      try {
        completer.complete(await operation());
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<Map<String, Object?>> _expect(String type) {
    if (_waiters.containsKey(type)) {
      throw StateError('Duplicate live-caption waiter: $type');
    }
    final completer = Completer<Map<String, Object?>>();
    _waiters[type] = completer;
    return completer.future;
  }

  void _send(Map<String, Object?> value) {
    final process = _process;
    if (process == null || _closed) {
      throw const LiveCaptionWorkerFailure(
        'WORKER_UNAVAILABLE',
        'Live-caption worker is unavailable',
      );
    }
    final line = jsonEncode(value);
    if (utf8.encode(line).length > maximumLiveCaptionWorkerLineBytes) {
      throw const FormatException('Live-caption request is too large');
    }
    process.stdin.writeln(line);
  }

  void _handleLine(String line) {
    try {
      if (utf8.encode(line).length > maximumLiveCaptionWorkerLineBytes) {
        throw const FormatException('Live-caption event is too large');
      }
      final second = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (second != _rateWindowSecond) {
        _rateWindowSecond = second;
        _rateWindowCount = 0;
      }
      _rateWindowCount += 1;
      if (_rateWindowCount > maximumLiveCaptionEventsPerSecond) {
        throw const FormatException('Live-caption event rate exceeded');
      }
      final decoded = jsonDecode(line);
      if (decoded is! Map) {
        throw const FormatException('Live-caption event is not an object');
      }
      final event = decoded.cast<String, Object?>();
      final type = event['type'];
      if (event['schemaVersion'] != 1 ||
          type is! String ||
          !const <String>{
            'ready',
            'sessionReady',
            'utterance',
            'pollComplete',
            'sessionComplete',
            'error',
          }.contains(type)) {
        throw const FormatException('Invalid live-caption event envelope');
      }
      if (type == 'error') {
        throw LiveCaptionWorkerFailure(
          event['code'] as String? ?? 'WORKER_ERROR',
          event['message'] as String? ?? 'Live-caption worker failed',
        );
      }
      final waiter = _waiters.remove(type);
      if (waiter != null && !waiter.isCompleted) waiter.complete(event);
      _events.add(event);
    } catch (error, stackTrace) {
      _fail(error, stackTrace);
    }
  }

  void _requireSession(
    Map<String, Object?> event,
    String sessionId,
    int generationId,
  ) {
    if (event['sessionId'] != sessionId ||
        event['generationId'] != generationId) {
      throw const LiveCaptionWorkerFailure(
        'SESSION_MISMATCH',
        'Live-caption worker reported a different session',
      );
    }
  }

  void _stdoutDone() {
    if (!_closed) {
      _fail(
        const LiveCaptionWorkerFailure(
          'WORKER_STDOUT_CLOSED',
          'Live-caption worker closed its event stream',
        ),
      );
    }
  }

  void _fail(Object error, [StackTrace? stackTrace]) {
    final failure = error is LiveCaptionWorkerFailure
        ? error
        : LiveCaptionWorkerFailure(
            'INVALID_WORKER_OUTPUT',
            error.runtimeType.toString(),
          );
    _completeWaiters(failure, stackTrace);
    if (!_events.isClosed) _events.addError(failure, stackTrace);
    _process?.kill();
  }

  void _completeWaiters(Object error, [StackTrace? stackTrace]) {
    for (final waiter in _waiters.values) {
      if (!waiter.isCompleted) waiter.completeError(error, stackTrace);
    }
    _waiters.clear();
  }

  static Future<Process> _startProcess(
    String executable,
    List<String> arguments, {
    required Map<String, String> environment,
    required bool includeParentEnvironment,
  }) {
    return Process.start(
      executable,
      arguments,
      environment: environment,
      includeParentEnvironment: includeParentEnvironment,
      mode: ProcessStartMode.normal,
    );
  }
}
