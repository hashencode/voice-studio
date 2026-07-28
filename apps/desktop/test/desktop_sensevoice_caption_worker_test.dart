import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

import '../tool/desktop_sensevoice_caption_worker.dart';

void main() {
  Map<String, Object?> control() => <String, Object?>{
    'provider': 'cpu',
    'threads': 2,
    'concurrency': 1,
    'decodingMethod': 'greedy_search',
    'language': 'auto',
    'useInverseTextNormalization': false,
    'recognizerLifecycle': 'resident_preloaded',
    'vadThreshold': 0.5,
    'minimumSpeechSeconds': 0.25,
    'minimumSilenceSeconds': 0.5,
    'maximumUtteranceSeconds': 15.0,
    'publishesTokenPartials': false,
    'publishesCompletedUtterancesOnly': true,
  };

  test('accepts only the frozen U13 control', () {
    final parsed = SenseVoiceWorkerControl.fromJson(control());
    expect(parsed.threads, 2);
    expect(parsed.publishesTokenPartials, isFalse);

    for (final mutation in <void Function(Map<String, Object?>)>[
      (value) => value['threads'] = 3,
      (value) => value['useInverseTextNormalization'] = true,
      (value) => value['vadThreshold'] = 0.4,
      (value) => value['publishesTokenPartials'] = true,
    ]) {
      final changed = control();
      mutation(changed);
      expect(
        () => SenseVoiceWorkerControl.fromJson(changed),
        throwsFormatException,
      );
    }
  });

  test('U18 mode accepts only preregistered bounded profile values', () {
    final optimized = control()
      ..['threads'] = 3
      ..['language'] = 'zh'
      ..['useInverseTextNormalization'] = true
      ..['vadThreshold'] = 0.4
      ..['minimumSpeechSeconds'] = 0.15
      ..['minimumSilenceSeconds'] = 0.35
      ..['maximumUtteranceSeconds'] = 12.0;

    final parsed = SenseVoiceWorkerControl.fromJson(
      optimized,
      allowU18Optimization: true,
    );
    expect(parsed.threads, 3);
    expect(parsed.language, 'zh');

    expect(
      () => SenseVoiceWorkerControl.fromJson(optimized),
      throwsFormatException,
    );
    for (final mutation in <void Function(Map<String, Object?>)>[
      (value) => value['threads'] = 4,
      (value) => value['language'] = 'fr',
      (value) => value['vadThreshold'] = 0.45,
      (value) => value['minimumSilenceSeconds'] = 0.2,
      (value) => value['maximumUtteranceSeconds'] = 20.0,
      (value) => value['publishesTokenPartials'] = true,
    ]) {
      final changed = Map<String, Object?>.from(optimized);
      mutation(changed);
      expect(
        () => SenseVoiceWorkerControl.fromJson(
          changed,
          allowU18Optimization: true,
        ),
        throwsFormatException,
      );
    }
  });

  test('decode request rejects invalid identity and missing hashes', () {
    expect(
      () => SenseVoiceDecodeRequest.fromJson(<String, Object?>{
        'schemaVersion': 1,
        'type': 'decode',
        'requestId': '../escape',
        'fixtureId': 'fixture',
        'sourcePath': '/tmp/source.wav',
        'sourceSha256': 'short',
        'replayRealtime': true,
      }),
      throwsFormatException,
    );
  });

  test('spool request binds fixed relative path and aligned offset', () {
    final request = SenseVoiceSpoolOpenRequest.fromJson(<String, Object?>{
      'schemaVersion': 1,
      'type': 'openSession',
      'sessionId': 'session-u14',
      'generationId': 2,
      'spoolRelativePath': 'caption/live-caption.pcmspool',
      'offsetBytes': 3200,
      'firstSequence': 3,
    });
    expect(request.offsetBytes, 3200);
    expect(
      () => SenseVoiceSpoolOpenRequest.fromJson(<String, Object?>{
        'schemaVersion': 1,
        'type': 'openSession',
        'sessionId': 'session-u14',
        'generationId': 2,
        'spoolRelativePath': '../escape',
        'offsetBytes': 1,
        'firstSequence': 3,
      }),
      throwsFormatException,
    );
  });

  test('hard split never emits more than fifteen seconds', () {
    final ranges = hardSplitRanges(
      19 * liveCaptionSampleRate,
      15 * liveCaptionSampleRate,
    );

    expect(ranges, <({int start, int end})>[
      (start: 0, end: 15 * liveCaptionSampleRate),
      (start: 15 * liveCaptionSampleRate, end: 19 * liveCaptionSampleRate),
    ]);
    expect(
      ranges.every(
        (range) => range.end - range.start <= 15 * liveCaptionSampleRate,
      ),
      isTrue,
    );
  });

  test('contained file resolves and hash verifies', () async {
    final root = await Directory.systemTemp.createTemp('sensevoice-worker-');
    addTearDown(() => root.delete(recursive: true));
    final file = File('${root.path}/fixture.wav');
    await file.writeAsBytes(<int>[1, 2, 3]);
    final digest = sha256.convert(<int>[1, 2, 3]).toString();

    expect(
      (await resolveContainedFile(file, root)).path,
      await file.resolveSymbolicLinks(),
    );
    await verifyFile(file, digest);
  });

  test('symlink escape is rejected', () async {
    final root = await Directory.systemTemp.createTemp('sensevoice-root-');
    final outside = await Directory.systemTemp.createTemp(
      'sensevoice-outside-',
    );
    addTearDown(() async {
      await root.delete(recursive: true);
      await outside.delete(recursive: true);
    });
    final target = File('${outside.path}/fixture.wav');
    await target.writeAsBytes(<int>[1]);
    final link = Link('${root.path}/fixture.wav');
    await link.create(target.path);

    await expectLater(
      resolveContainedFile(File(link.path), root),
      throwsA(isA<FileSystemException>()),
    );
  });

  test('control JSON round trips without hidden fields', () {
    final parsed = SenseVoiceWorkerControl.fromJson(control());
    expect(jsonDecode(jsonEncode(parsed.toJson())), control());
  });
}
