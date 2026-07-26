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
const double _maximumDurationSeconds = 14400;

Future<void> main(List<String> arguments) async {
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
    final request = CandidateWorkerRequest.decodeLine(line);
    await _validateFiles(request);
    _emit(<String, Object?>{
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
    _emit(<String, Object?>{
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
      OfflineSherpaProfile() => _decodeOffline(
        request: request,
        profile: built,
        wave: wave,
      ),
    };
    _validateResult(request, result);
    _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'result',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'sourceSha256': request.sourceSha256,
      ...result,
    });
    _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'unloadStart',
      'candidateId': request.candidateId,
    });
    _emit(<String, Object?>{
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
    _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'complete',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'temporaryArtifactsReleased': true,
      'residentBytesAfterSettle': ProcessInfo.currentRss,
    });
  } catch (error) {
    _emit(<String, Object?>{
      'schemaVersion': 2,
      'type': 'error',
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
  _emit(<String, Object?>{
    'schemaVersion': 2,
    'type': 'modelLoadComplete',
    'candidateId': request.candidateId,
    'loadMilliseconds': load.elapsedMicroseconds / 1000,
    'residentBytes': ProcessInfo.currentRss,
  });
  final stream = recognizer.createStream();
  final liveClock = Stopwatch()..start();
  var decodeMicroseconds = 0;
  var partialCount = 0;
  var previousText = '';
  try {
    final chunkSamples = request.profileId == 'recommended'
        ? max(1, (wave.sampleRate * profile.chunkSeconds).round())
        : max(1, wave.sampleRate ~/ 10);
    for (var offset = 0; offset < wave.samples.length; offset += chunkSamples) {
      final end = min(offset + chunkSamples, wave.samples.length);
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
      if (request.capabilities.partialResults) {
        final partial = recognizer.getResult(stream).text;
        if (partial.isNotEmpty && partial != previousText) {
          previousText = partial;
          partialCount += 1;
          if (partialCount <= 10000) {
            _emit(<String, Object?>{
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
          profile.effectiveConfig['pacingPolicy'] == 'realtime_audio_clock') {
        final target = Duration(
          microseconds: (end * Duration.microsecondsPerSecond / wave.sampleRate)
              .round(),
        );
        final remaining = target - liveClock.elapsed;
        if (remaining > Duration.zero) await Future<void>.delayed(remaining);
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
    liveClock.stop();
    return <String, Object?>{
      'text': result.text,
      'tokens': result.tokens,
      'timestamps': result.timestamps,
      'durationSeconds': wave.samples.length / wave.sampleRate,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'decodeMilliseconds': decodeMicroseconds / 1000,
      'liveElapsedMilliseconds': liveClock.elapsedMicroseconds / 1000,
      'partialCount': partialCount,
      'droppedChunkCount': 0,
      'maximumQueuedChunkCount': 1,
      'residentBytes': ProcessInfo.currentRss,
    };
  } finally {
    stream.free();
    recognizer.free();
  }
}

Map<String, Object?> _decodeOffline({
  required CandidateWorkerRequest request,
  required OfflineSherpaProfile profile,
  required sherpa.WaveData wave,
}) {
  final load = Stopwatch()..start();
  final recognizer = sherpa.OfflineRecognizer(profile.config);
  load.stop();
  _emit(<String, Object?>{
    'schemaVersion': 2,
    'type': 'modelLoadComplete',
    'candidateId': request.candidateId,
    'loadMilliseconds': load.elapsedMicroseconds / 1000,
    'residentBytes': ProcessInfo.currentRss,
  });
  final stream = recognizer.createStream();
  final decode = Stopwatch()..start();
  try {
    stream.acceptWaveform(samples: wave.samples, sampleRate: wave.sampleRate);
    recognizer.decode(stream);
    final result = recognizer.getResult(stream);
    decode.stop();
    return <String, Object?>{
      'text': result.text,
      'tokens': result.tokens,
      'timestamps': result.timestamps,
      'language': result.lang,
      'event': result.event,
      'durationSeconds': wave.samples.length / wave.sampleRate,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'decodeMilliseconds': decode.elapsedMicroseconds / 1000,
      'partialCount': 0,
      'residentBytes': ProcessInfo.currentRss,
    };
  } finally {
    stream.free();
    recognizer.free();
  }
}

Future<void> _validateFiles(CandidateWorkerRequest request) async {
  final source = File(request.sourcePath);
  if (!await source.exists() || await _sha256(source) != request.sourceSha256) {
    throw const FormatException('source identity mismatch');
  }
  for (final model in request.modelFiles.values) {
    final file = File(model.path);
    if (!await file.exists() || await _sha256(file) != model.sha256) {
      throw const FormatException('model identity mismatch');
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

void _emit(Map<String, Object?> event) {
  stdout.writeln(jsonEncode(event));
}
