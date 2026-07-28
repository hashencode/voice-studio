import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:voice2text_desktop/features/captions/live_caption_worker_client.dart';

void main() {
  test('client validates session identity and serializes control', () async {
    final process = _FakeWorkerProcess();
    final client = LiveCaptionWorkerClient(
      configuration: const LiveCaptionWorkerConfiguration(
        executable: '/worker',
        arguments: <String>[],
        sessionRoot: '/session',
        modelSha256: _hash,
      ),
      processStarter:
          (
            executable,
            arguments, {
            required environment,
            required includeParentEnvironment,
          }) async {
            scheduleMicrotask(process.ready);
            return process;
          },
    );

    await client.start();
    final opened = await client.openSession(
      sessionId: 'session-u14',
      generationId: 3,
      offsetBytes: 0,
      firstSequence: 1,
    );
    expect(opened['modelSha256'], _hash);
    final polled = await client.poll(sessionId: 'session-u14', generationId: 3);
    expect(polled['offsetBytes'], 3200);
    await client.close();
    expect(process.requests.map((request) => request['type']), <Object?>[
      'openSession',
      'poll',
      'shutdown',
    ]);
  });

  test('worker session mismatch fails closed', () async {
    final process = _FakeWorkerProcess(mismatch: true);
    final client = LiveCaptionWorkerClient(
      configuration: const LiveCaptionWorkerConfiguration(
        executable: '/worker',
        arguments: <String>[],
        sessionRoot: '/session',
        modelSha256: _hash,
      ),
      processStarter:
          (
            executable,
            arguments, {
            required environment,
            required includeParentEnvironment,
          }) async {
            scheduleMicrotask(process.ready);
            return process;
          },
    );
    await client.start();
    await expectLater(
      client.openSession(
        sessionId: 'session-u14',
        generationId: 3,
        offsetBytes: 0,
        firstSequence: 1,
      ),
      throwsA(isA<LiveCaptionWorkerFailure>()),
    );
    await client.close();
  });
}

const String _hash =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class _FakeWorkerProcess implements Process {
  _FakeWorkerProcess({this.mismatch = false}) {
    _stdin.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          final request = (jsonDecode(line) as Map).cast<String, Object?>();
          requests.add(request);
          switch (request['type']) {
            case 'openSession':
              _emit(<String, Object?>{
                'schemaVersion': 1,
                'type': 'sessionReady',
                'sessionId': mismatch ? 'session-other' : request['sessionId'],
                'generationId': request['generationId'],
                'offsetBytes': request['offsetBytes'],
                'nextSequence': request['firstSequence'],
                'modelSha256': _hash,
              });
              break;
            case 'poll':
              _emit(<String, Object?>{
                'schemaVersion': 1,
                'type': 'pollComplete',
                'sessionId': request['sessionId'],
                'generationId': 3,
                'offsetBytes': 3200,
                'nextSequence': 1,
                'backlogBytes': 0,
              });
              break;
            case 'shutdown':
              _finish(0);
              break;
          }
        });
  }

  final bool mismatch;
  final StreamController<List<int>> _stdin = StreamController<List<int>>();
  final StreamController<List<int>> _stdout = StreamController<List<int>>();
  final StreamController<List<int>> _stderr = StreamController<List<int>>();
  final Completer<int> _exit = Completer<int>();
  final List<Map<String, Object?>> requests = <Map<String, Object?>>[];
  late final IOSink _input = IOSink(_stdin.sink);

  void ready() {
    _emit(const <String, Object?>{
      'schemaVersion': 1,
      'type': 'ready',
      'protocol': 'sensevoice-live-caption-worker/v1',
    });
  }

  void _emit(Map<String, Object?> event) {
    _stdout.add(utf8.encode('${jsonEncode(event)}\n'));
  }

  void _finish(int code) {
    if (!_exit.isCompleted) _exit.complete(code);
    unawaited(_stdout.close());
    unawaited(_stderr.close());
  }

  @override
  Future<int> get exitCode => _exit.future;

  @override
  int get pid => 123;

  @override
  Stream<List<int>> get stderr => _stderr.stream;

  @override
  IOSink get stdin => _input;

  @override
  Stream<List<int>> get stdout => _stdout.stream;

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    _finish(-1);
    return true;
  }
}
