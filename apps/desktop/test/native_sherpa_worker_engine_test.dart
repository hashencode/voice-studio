import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';
import 'package:voice2text_desktop/features/processing/native_sherpa_worker_engine.dart';
import 'package:voice2text_desktop/features/processing/sherpa_desktop_processing_engine.dart';

void main() {
  late _Fixture fixture;

  setUp(() async {
    fixture = await _Fixture.open();
  });

  tearDown(() => fixture.dispose());

  test(
    'isolated ASR and diarization phases publish anonymous assignments',
    () async {
      final progress = <ProcessingProgress>[];
      final engine = fixture.engine(await fixture.worker(_Mode.success));

      final result = await engine.process(
        fixture.job,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: progress.add,
      );

      expect(result.diarizationSucceeded, isTrue);
      expect(result.segments, hasLength(2));
      expect(
        result.segments.map((segment) => segment.anonymousSpeakerKey),
        <String?>['speaker-1', 'speaker-2'],
      );
      expect(
        progress.map((item) => item.phase),
        containsAll(<String>['asr', 'diarization']),
      );
    },
  );

  test(
    'diarization failure preserves ASR as an explicit partial success',
    () async {
      final engine = fixture.engine(
        await fixture.worker(_Mode.diarizationFails),
      );

      final result = await engine.process(
        fixture.job,
        cancellationToken: ProcessingCancellationToken(),
        onProgress: (_) {},
      );

      expect(result.diarizationSucceeded, isFalse);
      expect(result.diarizationErrorCode, 'DIARIZATION_FAILED');
      expect(result.segments.map((segment) => segment.text), <String>[
        '确认',
        '发布',
      ]);
      expect(
        result.segments.every(
          (segment) => segment.speakerAssignment == SpeakerAssignment.unknown,
        ),
        isTrue,
      );
    },
  );

  test(
    'worker exit without a result fails promptly instead of waiting timeout',
    () async {
      final engine = fixture.engine(await fixture.worker(_Mode.exitsEarly));
      final watch = Stopwatch()..start();

      await expectLater(
        engine.process(
          fixture.job,
          cancellationToken: ProcessingCancellationToken(),
          onProgress: (_) {},
        ),
        throwsA(isA<StateError>()),
      );

      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
    },
  );

  test('cancellation kills a TERM-resistant process group', () async {
    final engine = fixture.engine(await fixture.worker(_Mode.hangs));
    final cancellation = ProcessingCancellationToken();
    final watch = Stopwatch()..start();
    final future = engine.process(
      fixture.job,
      cancellationToken: cancellation,
      onProgress: (_) {},
    );
    await Future<void>.delayed(const Duration(milliseconds: 150));
    cancellation.cancel();

    await expectLater(future, throwsA(isA<ProcessingCancelled>()));

    expect(watch.elapsed, lessThan(const Duration(seconds: 3)));
  });

  test(
    'managed source containment rejects external and symlink paths',
    () async {
      final worker = await fixture.worker(_Mode.success);
      final engine = fixture.engine(worker);
      final outside = File(p.join(fixture.root.path, 'outside.wav'));
      await outside.writeAsBytes(<int>[1, 2, 3]);
      final symlink = Link(p.join(fixture.importRoot.path, 'link.wav'));
      await symlink.create(outside.path);

      for (final path in <String>[outside.path, symlink.path]) {
        await expectLater(
          engine.process(
            fixture.jobWithPath(path),
            cancellationToken: ProcessingCancellationToken(),
            onProgress: (_) {},
          ),
          throwsA(isA<StateError>()),
        );
      }
    },
  );

  test('long-meeting shards align speakers and remove overlap duplicates', () {
    final merged = mergeDiarizationShardResults(
      first: <String, Object?>{
        'sourceSha256': _Fixture.fingerprint,
        'residentBytes': 100,
        'turns': <Object?>[
          <String, Object?>{
            'startSeconds': 3520.0,
            'endSeconds': 3590.0,
            'speakerKey': 'first-a',
          },
          <String, Object?>{
            'startSeconds': 3590.0,
            'endSeconds': 3650.0,
            'speakerKey': 'first-b',
          },
        ],
      },
      second: <String, Object?>{
        'sourceSha256': _Fixture.fingerprint,
        'residentBytes': 200,
        'turns': <Object?>[
          <String, Object?>{
            'startSeconds': 3540.0,
            'endSeconds': 3590.0,
            'speakerKey': 'second-x',
          },
          <String, Object?>{
            'startSeconds': 3590.0,
            'endSeconds': 3650.0,
            'speakerKey': 'second-y',
          },
          <String, Object?>{
            'startSeconds': 3700.0,
            'endSeconds': 3750.0,
            'speakerKey': 'second-z',
          },
        ],
      },
      splitSeconds: 3600,
      overlapStartSeconds: 3540,
      overlapEndSeconds: 3660,
    );

    final turns = merged['turns']! as List<Object?>;
    expect(merged['residentBytes'], 300);
    expect(merged['shardCount'], 2);
    expect(
      turns
          .map((turn) => (turn! as Map<String, Object?>)['speakerKey'])
          .toList(),
      <String>['first-a', 'first-b', 'first-b', 'shard_02_second-z'],
    );
    expect(
      turns.where((turn) {
        final value = turn! as Map<String, Object?>;
        return (value['startSeconds']! as double) < 3600 &&
            (value['endSeconds']! as double) > 3600;
      }),
      isEmpty,
    );
  });
}

enum _Mode { success, diarizationFails, exitsEarly, hangs }

class _Fixture {
  const _Fixture({
    required this.root,
    required this.importRoot,
    required this.source,
    required this.launcher,
    required this.runtimeRoot,
    required this.models,
  });

  static const fingerprint =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  static Future<_Fixture> open() async {
    final root = await Directory.systemTemp.createTemp('native-worker-test-');
    final importRoot = Directory(p.join(root.path, 'imports'));
    final runtimeRoot = Directory(p.join(root.path, 'runtime'));
    final modelsRoot = Directory(p.join(root.path, 'models'));
    await importRoot.create();
    await runtimeRoot.create();
    await modelsRoot.create();
    final source = File(p.join(importRoot.path, 'meeting.wav'));
    await source.writeAsBytes(<int>[1, 2, 3]);
    final modelPaths = List<String>.generate(
      6,
      (index) => p.join(modelsRoot.path, '$index.model'),
    );
    for (var index = 0; index < modelPaths.length; index += 1) {
      await File(modelPaths[index]).writeAsBytes(<int>[index]);
    }
    final launcher = p.join(root.path, 'launcher');
    final current = Directory.current;
    final launcherSources = <File>[
      File(p.join(current.path, 'tool', 'native_process_group_launcher.c')),
      File(
        p.join(
          current.path,
          'apps',
          'desktop',
          'tool',
          'native_process_group_launcher.c',
        ),
      ),
    ];
    final launcherSource = launcherSources.firstWhere(
      (candidate) => candidate.existsSync(),
      orElse: () => throw StateError(
        'cannot locate native_process_group_launcher.c from ${current.path}',
      ),
    );
    final compile = await Process.run('/usr/bin/clang', <String>[
      launcherSource.path,
      '-o',
      launcher,
    ]);
    if (compile.exitCode != 0) {
      throw StateError('cannot compile test launcher: ${compile.stderr}');
    }
    return _Fixture(
      root: root,
      importRoot: importRoot,
      source: source,
      launcher: launcher,
      runtimeRoot: runtimeRoot,
      models: SherpaDesktopModelSet(
        encoderPath: modelPaths[0],
        decoderPath: modelPaths[1],
        joinerPath: modelPaths[2],
        tokensPath: modelPaths[3],
        segmentationPath: modelPaths[4],
        embeddingPath: modelPaths[5],
      ),
    );
  }

  final Directory root;
  final Directory importRoot;
  final File source;
  final String launcher;
  final Directory runtimeRoot;
  final SherpaDesktopModelSet models;

  DesktopProcessingJob get job => jobWithPath(source.path);

  DesktopProcessingJob jobWithPath(String path) => DesktopProcessingJob(
    id: 1,
    recordingId: 1,
    displayName: 'meeting.wav',
    recordingPath: path,
    fingerprintSha256: fingerprint,
    state: DesktopJobState.processing,
    stage: 'preparing',
    progress: 0,
    createdAtMs: 1,
  );

  NativeSherpaWorkerEngine engine(String worker) => NativeSherpaWorkerEngine(
    NativeSherpaWorkerConfiguration(
      launcherPath: launcher,
      workerPath: worker,
      runtimeRoot: runtimeRoot.path,
      importRoot: importRoot.path,
      models: models,
      timeout: const Duration(seconds: 2),
    ),
  );

  Future<String> worker(_Mode mode) async {
    final path = p.join(root.path, 'worker-${mode.name}.sh');
    final file = File(path);
    final body = switch (mode) {
      _Mode.success => _workerBody(diarizationFails: false),
      _Mode.diarizationFails => _workerBody(diarizationFails: true),
      _Mode.exitsEarly => '#!/bin/sh\nread request\nexit 17\n',
      _Mode.hangs =>
        '#!/bin/sh\n'
            "trap '' TERM\n"
            'read request\n'
            'while true; do /bin/sleep 1; done\n',
    };
    await file.writeAsString(body, flush: true);
    final chmod = await Process.run('/bin/chmod', <String>['755', path]);
    if (chmod.exitCode != 0) throw StateError('cannot make worker executable');
    return path;
  }

  Future<void> dispose() async {
    if (await root.exists()) await root.delete(recursive: true);
  }
}

String _workerBody({required bool diarizationFails}) {
  final diarization = diarizationFails
      ? '''  echo '{"schemaVersion":1,"type":"error","code":"DIAR_FAIL"}'
'''
      : '''  echo '{"schemaVersion":1,"type":"progress","phase":"diarization","fraction":0.5}'
  echo '{"schemaVersion":1,"type":"result","phase":"diarization","sourceSha256":"${_Fixture.fingerprint}","turns":[{"startSeconds":0.0,"endSeconds":1.0,"speakerKey":"speaker-1"},{"startSeconds":1.0,"endSeconds":2.0,"speakerKey":"speaker-2"}],"residentBytes":2048}'
''';
  return '#!/bin/sh\n'
      'phase=""\n'
      'while [ "\$#" -gt 0 ]; do\n'
      '  if [ "\$1" = "--phase" ]; then phase="\$2"; shift 2; else shift; fi\n'
      'done\n'
      'read request\n'
      'if [ "\$phase" = "asr" ]; then\n'
      '''  echo '{"schemaVersion":1,"type":"progress","phase":"asr","fraction":0.5}'
  echo '{"schemaVersion":1,"type":"result","phase":"asr","sourceSha256":"${_Fixture.fingerprint}","text":"确认发布","durationSeconds":2.0,"tokens":["确认","发布"],"timestamps":[0.0,1.0],"residentBytes":1024}'
'''
      'elif [ "\$phase" = "diarization" ]; then\n'
      '$diarization'
      'fi\n';
}
