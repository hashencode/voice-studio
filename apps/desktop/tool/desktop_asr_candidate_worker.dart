import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'asr_benchmark/candidate_registry.dart';
import 'asr_benchmark/effective_profile.dart';

const int _maximumOutputTextBytes = 1024 * 1024;
const int _maximumTokenCount = 100000;
const int _maximumTimestampCount = 100000;
const int _maximumPartialEvents = 240;
const double _maximumDurationSeconds = 14400;

Future<void> main(List<String> arguments) async {
  CandidateWorkerRequest? request;
  try {
    final options = _parseArguments(arguments);
    final lines = StreamIterator<String>(
      stdin.transform(utf8.decoder).transform(const LineSplitter()),
    );
    if (!await lines.moveNext()) {
      throw const FormatException('worker request is missing');
    }
    final line = lines.current;
    if (utf8.encode(line).length > 4 * 1024 * 1024) {
      throw const FormatException('worker request exceeds the input bound');
    }
    request = CandidateWorkerRequest.decodeLine(line);
    await _validateFiles(request);
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'handshake',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'sourceSha256': request.sourceSha256,
      'processId': pid,
      'runtimeBindingState': 'not_initialized',
    });
    if (!await lines.moveNext()) {
      throw const FormatException('baseline freeze acknowledgement is missing');
    }
    BaselineFreezeAck.validate(jsonDecode(lines.current), request);
    await lines.cancel();

    final runtimeRoot = _required(options, 'runtime-root');
    sherpa.initBindings(runtimeRoot);
    final wave = sherpa.readWave(request.sourcePath);
    if (wave.samples.isEmpty ||
        wave.sampleRate != 16000 ||
        wave.samples.length / wave.sampleRate > _maximumDurationSeconds) {
      throw const FormatException('source must be bounded mono 16 kHz PCM');
    }
    final profile = EffectiveProfile.fromCandidateRequest(request);
    final built = profile.build();
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'effectiveConfig',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'family': request.family.manifestValue,
      'effectiveConfig': built.effectiveConfig,
      'capabilities': request.capabilities.toJson(),
      'modelFileSha256': <String, Object?>{
        for (final entry in request.modelFiles.entries)
          entry.key: entry.value.sha256,
      },
    });

    final result = switch (built) {
      OnlineSherpaProfile() => await _decodeOnline(
        request: request,
        profile: built,
        wave: wave,
      ),
      OfflineSherpaProfile() => await _decodeOffline(
        request: request,
        profile: built,
        wave: wave,
      ),
    };
    _validateResult(request, result);
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'result',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'sourceSha256': request.sourceSha256,
      ...result,
    });
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'unloadStart',
      'candidateId': request.candidateId,
    });
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'unloadComplete',
      'candidateId': request.candidateId,
      'residentBytes': ProcessInfo.currentRss,
    });
    if (request.settleMilliseconds > 0) {
      await Future<void>.delayed(
        Duration(milliseconds: request.settleMilliseconds),
      );
    }
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'complete',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'temporaryArtifactsReleased': true,
      'residentBytesAfterSettle': ProcessInfo.currentRss,
    });
  } catch (error, stackTrace) {
    stderr
      ..writeln(error)
      ..writeln(stackTrace);
    await _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'error',
      if (request != null) ...<String, Object?>{
        'candidateId': request.candidateId,
        'profileId': request.profileId,
        'sourceSha256': request.sourceSha256,
      },
      'code': switch (error) {
        FormatException() => 'INVALID_REQUEST_OR_IDENTITY',
        StateError() => 'DECODE_FAILED',
        _ => 'WORKER_FAILED',
      },
      'message': error.runtimeType.toString(),
    });
    exitCode = 1;
  }
}

Future<Map<String, Object?>> _decodeOnline({
  required CandidateWorkerRequest request,
  required OnlineSherpaProfile profile,
  required sherpa.WaveData wave,
}) async {
  final load = Stopwatch()..start();
  final recognizer = sherpa.OnlineRecognizer(profile.config);
  load.stop();
  await _emit(<String, Object?>{
    'schemaVersion': 2,
    'type': 'modelLoadComplete',
    'candidateId': request.candidateId,
    'loadMilliseconds': load.elapsedMicroseconds / 1000,
    'residentBytes': ProcessInfo.currentRss,
  });
  final liveClock = Stopwatch()..start();
  var decodeMicroseconds = 0;
  var partialCount = 0;
  var previousText = '';
  final texts = <String>[];
  final tokens = <String>[];
  final timestamps = <double>[];
  final segmentWallMilliseconds = <double>[];
  final segments = _decodeSegments(
    wave: wave,
    profileId: request.profileId,
    effectiveConfig: profile.effectiveConfig,
  );
  try {
    final chunkSamples = request.profileId == 'recommended'
        ? max(1, (wave.sampleRate * profile.chunkSeconds).round())
        : max(1, wave.sampleRate ~/ 10);
    for (final segment in segments) {
      final stream = recognizer.createStream();
      final segmentWall = Stopwatch()..start();
      try {
        for (
          var offset = segment.startSample;
          offset < segment.endSample;
          offset += chunkSamples
        ) {
          final end = min(offset + chunkSamples, segment.endSample);
          stream.acceptWaveform(
            samples: Float32List.sublistView(wave.samples, offset, end),
            sampleRate: wave.sampleRate,
          );
          while (recognizer.isReady(stream)) {
            final decode = Stopwatch()..start();
            recognizer.decode(stream);
            decode.stop();
            decodeMicroseconds += decode.elapsedMicroseconds;
          }
          if (request.profileId == 'recommended' &&
              request.capabilities.partialResults) {
            final partial = recognizer.getResult(stream).text;
            if (partial.isNotEmpty && partial != previousText) {
              previousText = partial;
              partialCount += 1;
              if (partialCount <= _maximumPartialEvents) {
                await _emit(<String, Object?>{
                  'schemaVersion': 2,
                  'type': 'partial',
                  'candidateId': request.candidateId,
                  'audioSeconds': end / wave.sampleRate,
                  'wallMilliseconds': liveClock.elapsedMicroseconds / 1000,
                  'textSha256': sha256.convert(utf8.encode(partial)).toString(),
                });
              }
            }
          }
          if (request.profileId == 'recommended' &&
              profile.effectiveConfig['pacingPolicy'] ==
                  'realtime_audio_clock') {
            final target = Duration(
              microseconds:
                  (end * Duration.microsecondsPerSecond / wave.sampleRate)
                      .round(),
            );
            final remaining = target - liveClock.elapsed;
            if (remaining > Duration.zero) {
              await Future<void>.delayed(remaining);
            }
          }
        }
        stream.inputFinished();
        while (recognizer.isReady(stream)) {
          final decode = Stopwatch()..start();
          recognizer.decode(stream);
          decode.stop();
          decodeMicroseconds += decode.elapsedMicroseconds;
        }
        final result = recognizer.getResult(stream);
        if (result.text.isNotEmpty) texts.add(result.text);
        tokens.addAll(result.tokens);
        final offsetSeconds = segment.startSample / wave.sampleRate;
        timestamps.addAll(
          result.timestamps.map((value) => value + offsetSeconds),
        );
      } finally {
        segmentWall.stop();
        segmentWallMilliseconds.add(segmentWall.elapsedMicroseconds / 1000);
        stream.free();
      }
    }
    liveClock.stop();
    return <String, Object?>{
      'text': texts.join(' '),
      'tokens': tokens,
      'timestamps': timestamps,
      'durationSeconds': wave.samples.length / wave.sampleRate,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'decodeMilliseconds': decodeMicroseconds / 1000,
      'segmentWallMilliseconds': segmentWallMilliseconds,
      'liveElapsedMilliseconds': liveClock.elapsedMicroseconds / 1000,
      'segmentCount': segments.length,
      'partialCount': partialCount,
      'droppedChunkCount': 0,
      'maximumQueuedChunkCount': 1,
      'residentBytes': ProcessInfo.currentRss,
    };
  } finally {
    recognizer.free();
  }
}

Future<Map<String, Object?>> _decodeOffline({
  required CandidateWorkerRequest request,
  required OfflineSherpaProfile profile,
  required sherpa.WaveData wave,
}) async {
  final load = Stopwatch()..start();
  final recognizer = sherpa.OfflineRecognizer(profile.config);
  load.stop();
  await _emit(<String, Object?>{
    'schemaVersion': 2,
    'type': 'modelLoadComplete',
    'candidateId': request.candidateId,
    'loadMilliseconds': load.elapsedMicroseconds / 1000,
    'residentBytes': ProcessInfo.currentRss,
  });
  final decode = Stopwatch()..start();
  final texts = <String>[];
  final tokens = <String>[];
  final timestamps = <double>[];
  final segmentWallMilliseconds = <double>[];
  String? language;
  String? event;
  final segments = _decodeSegments(
    wave: wave,
    profileId: request.profileId,
    effectiveConfig: profile.effectiveConfig,
  );
  try {
    for (final segment in segments) {
      final stream = recognizer.createStream();
      final segmentWall = Stopwatch()..start();
      try {
        stream.acceptWaveform(
          samples: Float32List.sublistView(
            wave.samples,
            segment.startSample,
            segment.endSample,
          ),
          sampleRate: wave.sampleRate,
        );
        recognizer.decode(stream);
        final result = recognizer.getResult(stream);
        if (result.text.isNotEmpty) texts.add(result.text);
        tokens.addAll(result.tokens);
        final offsetSeconds = segment.startSample / wave.sampleRate;
        timestamps.addAll(
          result.timestamps.map((value) => value + offsetSeconds),
        );
        if (language == null && result.lang.isNotEmpty) language = result.lang;
        if (event == null && result.event.isNotEmpty) event = result.event;
      } finally {
        segmentWall.stop();
        segmentWallMilliseconds.add(segmentWall.elapsedMicroseconds / 1000);
        stream.free();
      }
    }
    decode.stop();
    return <String, Object?>{
      'text': texts.join(' '),
      'tokens': tokens,
      'timestamps': timestamps,
      'language': language ?? '',
      'event': event ?? '',
      'durationSeconds': wave.samples.length / wave.sampleRate,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'decodeMilliseconds': decode.elapsedMicroseconds / 1000,
      'segmentWallMilliseconds': segmentWallMilliseconds,
      'segmentCount': segments.length,
      'partialCount': 0,
      'residentBytes': ProcessInfo.currentRss,
    };
  } finally {
    recognizer.free();
  }
}

List<_DecodeSegment> _decodeSegments({
  required sherpa.WaveData wave,
  required String profileId,
  required Map<String, Object?> effectiveConfig,
}) {
  if (profileId != 'fixed-resource') {
    return <_DecodeSegment>[
      _DecodeSegment(startSample: 0, endSample: wave.samples.length),
    ];
  }
  final durationSeconds = effectiveConfig['segmentDurationSeconds'];
  if (durationSeconds is! int || durationSeconds <= 0 || durationSeconds > 60) {
    throw const FormatException('frozen segment duration is invalid');
  }
  final segmentSamples = wave.sampleRate * durationSeconds;
  return <_DecodeSegment>[
    for (var start = 0; start < wave.samples.length; start += segmentSamples)
      _DecodeSegment(
        startSample: start,
        endSample: min(start + segmentSamples, wave.samples.length),
      ),
  ];
}

class _DecodeSegment {
  const _DecodeSegment({required this.startSample, required this.endSample});

  final int startSample;
  final int endSample;
}

Future<void> _validateFiles(CandidateWorkerRequest request) async {
  final source = File(request.sourcePath);
  if (!await source.exists() || await _sha256(source) != request.sourceSha256) {
    throw const FormatException('source identity mismatch');
  }
  for (final entry in request.modelFiles.entries) {
    final model = entry.value;
    if (request.family == BenchmarkCandidateFamily.funasrNano &&
        entry.key == 'tokenizer') {
      final directory = Directory(model.path);
      if (!await directory.exists() ||
          await _sha256Directory(directory) != model.sha256) {
        throw const FormatException('model identity mismatch');
      }
    } else {
      final file = File(model.path);
      if (!await file.exists() || await _sha256(file) != model.sha256) {
        throw const FormatException('model identity mismatch');
      }
    }
  }
}

void _validateResult(
  CandidateWorkerRequest request,
  Map<String, Object?> result,
) {
  final text = result['text'];
  final tokens = result['tokens'];
  final timestamps = result['timestamps'];
  if (text is! String ||
      utf8.encode(text).length > _maximumOutputTextBytes ||
      (request.expectSpeech && text.trim().isEmpty) ||
      tokens is! List ||
      tokens.length > _maximumTokenCount ||
      timestamps is! List ||
      timestamps.length > _maximumTimestampCount ||
      timestamps.any(
        (value) => value is! num || !value.toDouble().isFinite || value < 0,
      )) {
    throw StateError('worker result exceeds the bounded observation contract');
  }
  var previous = 0.0;
  for (final value in timestamps.cast<num>()) {
    final current = value.toDouble();
    if (current < previous) {
      throw StateError('worker timestamps are not monotonic');
    }
    previous = current;
  }
  for (final key in <String>[
    'durationSeconds',
    'loadMilliseconds',
    'decodeMilliseconds',
  ]) {
    final value = result[key];
    if (value is! num || !value.toDouble().isFinite || value < 0) {
      throw StateError('worker timing is non-finite');
    }
  }
  final segmentWallMilliseconds = result['segmentWallMilliseconds'];
  final segmentCount = result['segmentCount'];
  if (segmentWallMilliseconds is! List ||
      segmentCount is! int ||
      segmentCount <= 0 ||
      segmentWallMilliseconds.length != segmentCount ||
      segmentWallMilliseconds.any(
        (value) => value is! num || !value.toDouble().isFinite || value < 0,
      )) {
    throw StateError('worker segment timing is invalid');
  }
}

Map<String, String> _parseArguments(List<String> arguments) {
  if (arguments.length.isOdd) {
    throw const FormatException('worker arguments must be key/value pairs');
  }
  final result = <String, String>{};
  for (var index = 0; index < arguments.length; index += 2) {
    final key = arguments[index];
    if (!key.startsWith('--') || result.containsKey(key.substring(2))) {
      throw const FormatException('worker argument is invalid');
    }
    result[key.substring(2)] = arguments[index + 1];
  }
  if (result.keys.toSet().difference(const <String>{
    'runtime-root',
  }).isNotEmpty) {
    throw const FormatException('unknown worker argument');
  }
  return result;
}

String _required(Map<String, String> options, String key) {
  final value = options[key];
  if (value == null || value.isEmpty) {
    throw FormatException('missing --$key');
  }
  return value;
}

Future<String> _sha256(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();

Future<String> _sha256Directory(Directory directory) async {
  final files = await directory
      .list(followLinks: false)
      .where((entity) => entity is File)
      .cast<File>()
      .toList();
  if (files.isEmpty || files.length > 16) {
    throw const FormatException('tokenizer directory is invalid');
  }
  files.sort((left, right) => left.path.compareTo(right.path));
  final identity = StringBuffer();
  for (final file in files) {
    final relative = file.uri.pathSegments.last;
    identity
      ..write(relative)
      ..write('\u0000')
      ..write(await _sha256(file))
      ..write('\n');
  }
  return sha256.convert(utf8.encode(identity.toString())).toString();
}

Future<void> _emit(Map<String, Object?> event) async {
  stdout.writeln(jsonEncode(event));
  // Resource measurement boundaries must reach the parent sampler while this
  // process is still alive; otherwise unload RSS collapses to a false zero.
  await stdout.flush();
}
