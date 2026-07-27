import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;
import 'package:sherpa_onnx/src/sherpa_onnx_bindings.dart';
import 'package:sherpa_onnx/src/utils.dart';
import 'package:voice2text_desktop/features/processing/qwen3_result.dart';

const int _schemaVersion = 2;
const double _maximumDurationSeconds = 600;

Future<void> main(List<String> arguments) async {
  Map<String, Object?>? request;
  try {
    final runtimeRoot = _runtimeRoot(arguments);
    final lines = StreamIterator<String>(
      stdin.transform(utf8.decoder).transform(const LineSplitter()),
    );
    if (!await lines.moveNext()) {
      throw const FormatException('diagnostic worker request is missing');
    }
    final decoded = jsonDecode(lines.current);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException(
        'diagnostic worker request must be an object',
      );
    }
    request = Map<String, Object?>.from(decoded);
    final candidateId = _string(request, 'candidateId');
    final profileId = _string(request, 'profileId');
    final sourceSha256 = _string(request, 'sourceSha256');
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'handshake',
      'candidateId': candidateId,
      'profileId': profileId,
      'sourceSha256': sourceSha256,
      'processId': pid,
      'runtimeBindingState': 'not_initialized',
    });
    if (!await lines.moveNext()) {
      throw const FormatException('baseline freeze acknowledgement is missing');
    }
    final acknowledgement = jsonDecode(lines.current);
    if (acknowledgement is! Map<String, dynamic> ||
        acknowledgement['schemaVersion'] != _schemaVersion ||
        acknowledgement['type'] != 'baselineFrozen' ||
        acknowledgement['candidateId'] != candidateId ||
        acknowledgement['profileId'] != profileId ||
        acknowledgement['sourceSha256'] != sourceSha256) {
      throw const FormatException('baseline freeze acknowledgement is invalid');
    }
    await lines.cancel();

    sherpa.initBindings(runtimeRoot);
    final sourcePath = _string(request, 'sourcePath');
    final wave = sherpa.readWave(sourcePath);
    final durationSeconds = wave.samples.length / wave.sampleRate;
    if (wave.samples.isEmpty ||
        wave.sampleRate != 16000 ||
        durationSeconds > _maximumDurationSeconds) {
      throw const FormatException('source must be bounded mono 16 kHz PCM');
    }
    final config = _object(request, 'effectiveConfig');
    final modelFiles = _object(request, 'modelFiles');
    final segmentation = _string(request, 'diagnosticSegmentation');
    if (!const <String>{
      'fixed_15_seconds',
      'official_silero_vad',
    }.contains(segmentation)) {
      throw const FormatException('diagnostic segmentation is invalid');
    }
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'effectiveConfig',
      'candidateId': candidateId,
      'profileId': profileId,
      'family': 'qwen3_asr',
      'effectiveConfig': <String, Object?>{
        ...config,
        'diagnosticSegmentation': segmentation,
      },
      'capabilities': request['capabilities'] ?? const <String, Object?>{},
      'modelFileSha256': <String, Object?>{
        for (final entry in modelFiles.entries)
          entry.key: _objectValue(entry.value, 'sha256'),
      },
    });

    final load = Stopwatch()..start();
    final recognizer = sherpa.OfflineRecognizer(
      sherpa.OfflineRecognizerConfig(
        model: sherpa.OfflineModelConfig(
          qwen3Asr: sherpa.OfflineQwen3AsrModelConfig(
            convFrontend: _modelPath(modelFiles, 'convFrontend'),
            encoder: _modelPath(modelFiles, 'encoder'),
            decoder: _modelPath(modelFiles, 'decoder'),
            tokenizer: _modelPath(modelFiles, 'tokenizer'),
            maxTotalLen: _integer(config, 'maxTotalLen'),
            maxNewTokens: _integer(config, 'maxNewTokens'),
            temperature: _number(config, 'temperature'),
            topP: _number(config, 'topP'),
            seed: _integer(config, 'seed'),
            hotwords: _string(config, 'hotwords'),
          ),
          tokens: '',
          numThreads: _integer(config, 'numThreads'),
          provider: _string(config, 'provider'),
          debug: false,
        ),
      ),
    );
    load.stop();
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'modelLoadComplete',
      'candidateId': candidateId,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'residentBytes': ProcessInfo.currentRss,
    });

    final vad = Stopwatch()..start();
    final segments = segmentation == 'official_silero_vad'
        ? _sileroSegments(
            wave: wave,
            modelPath: _modelPath(modelFiles, 'sileroVad'),
          )
        : _fixedSegments(wave);
    vad.stop();
    final decodeResult = _decodeSegments(recognizer, segments);
    recognizer.free();

    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'result',
      'candidateId': candidateId,
      'profileId': profileId,
      'sourceSha256': sourceSha256,
      'text': decodeResult.text,
      'tokens': decodeResult.tokens,
      'timestamps': const <double>[],
      'durationSeconds': durationSeconds,
      'loadMilliseconds': load.elapsedMicroseconds / 1000,
      'decodeMilliseconds': decodeResult.decodeMilliseconds,
      'segmentWallMilliseconds': decodeResult.segmentWallMilliseconds,
      'segmentCount': segments.length,
      'segmentDurationsSeconds': <double>[
        for (final segment in segments)
          segment.samples.length / wave.sampleRate,
      ],
      'segmentStartSeconds': <double>[
        for (final segment in segments) segment.startSample / wave.sampleRate,
      ],
      'vadMilliseconds': vad.elapsedMicroseconds / 1000,
      'nativeResultFetchMilliseconds':
          decodeResult.nativeResultFetchMilliseconds,
      'ffiStringCopyMilliseconds': decodeResult.ffiStringCopyMilliseconds,
      'jsonRepairAndDecodeMilliseconds':
          decodeResult.jsonRepairAndDecodeMilliseconds,
      'resultConversionMilliseconds': decodeResult.resultConversionMilliseconds,
      'outputTokenCount': decodeResult.tokens.length,
      'residentBytes': ProcessInfo.currentRss,
    });
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'unloadStart',
      'candidateId': candidateId,
    });
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'unloadComplete',
      'candidateId': candidateId,
      'residentBytes': ProcessInfo.currentRss,
    });
    final settleMilliseconds =
        (request['settleMilliseconds'] as num?)?.toInt() ?? 0;
    if (settleMilliseconds > 0) {
      await Future<void>.delayed(Duration(milliseconds: settleMilliseconds));
    }
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'complete',
      'candidateId': candidateId,
      'profileId': profileId,
      'temporaryArtifactsReleased': true,
      'residentBytesAfterSettle': ProcessInfo.currentRss,
    });
  } catch (error, stackTrace) {
    stderr
      ..writeln(error)
      ..writeln(stackTrace);
    await _emit(<String, Object?>{
      'schemaVersion': _schemaVersion,
      'type': 'error',
      if (request != null) ...<String, Object?>{
        'candidateId': request['candidateId'],
        'profileId': request['profileId'],
        'sourceSha256': request['sourceSha256'],
      },
      'code': error is FormatException
          ? 'INVALID_REQUEST_OR_IDENTITY'
          : 'DECODE_FAILED',
      'message': error.runtimeType.toString(),
    });
    exitCode = 1;
  }
}

List<_Segment> _fixedSegments(sherpa.WaveData wave) {
  final segmentSamples = wave.sampleRate * 15;
  return <_Segment>[
    for (var start = 0; start < wave.samples.length; start += segmentSamples)
      _Segment(
        startSample: start,
        samples: Float32List.sublistView(
          wave.samples,
          start,
          min(start + segmentSamples, wave.samples.length),
        ),
      ),
  ];
}

List<_Segment> _sileroSegments({
  required sherpa.WaveData wave,
  required String modelPath,
}) {
  final detector = sherpa.VoiceActivityDetector(
    config: sherpa.VadModelConfig(
      sileroVad: sherpa.SileroVadModelConfig(
        model: modelPath,
        threshold: 0.2,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.2,
        maxSpeechDuration: 20,
        windowSize: 512,
      ),
      sampleRate: wave.sampleRate,
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    ),
    bufferSizeInSeconds: _maximumDurationSeconds,
  );
  final result = <_Segment>[];
  void drain() {
    while (!detector.isEmpty()) {
      final segment = detector.front();
      detector.pop();
      if (segment.samples.isNotEmpty) {
        result.add(
          _Segment(startSample: segment.start, samples: segment.samples),
        );
      }
    }
  }

  try {
    const windowSize = 512;
    for (var start = 0; start < wave.samples.length; start += windowSize) {
      detector.acceptWaveform(
        Float32List.sublistView(
          wave.samples,
          start,
          min(start + windowSize, wave.samples.length),
        ),
      );
      drain();
    }
    detector.flush();
    drain();
  } finally {
    detector.free();
  }
  if (result.isEmpty) {
    throw StateError('Silero VAD produced no speech segments');
  }
  return result;
}

_DecodeResult _decodeSegments(
  sherpa.OfflineRecognizer recognizer,
  List<_Segment> segments,
) {
  final decode = Stopwatch()..start();
  final texts = <String>[];
  final tokens = <String>[];
  final segmentWallMilliseconds = <double>[];
  var nativeResultFetchMicroseconds = 0;
  var ffiStringCopyMicroseconds = 0;
  var jsonRepairAndDecodeMicroseconds = 0;
  var resultConversionMicroseconds = 0;
  for (final segment in segments) {
    final stream = recognizer.createStream();
    final segmentWall = Stopwatch()..start();
    try {
      stream.acceptWaveform(samples: segment.samples, sampleRate: 16000);
      recognizer.decode(stream);
      final converted = _getQwen3Result(stream);
      if (converted.result.text.isNotEmpty) {
        texts.add(converted.result.text);
      }
      tokens.addAll(converted.result.tokens);
      nativeResultFetchMicroseconds += converted.nativeResultFetchMicroseconds;
      ffiStringCopyMicroseconds += converted.ffiStringCopyMicroseconds;
      jsonRepairAndDecodeMicroseconds +=
          converted.jsonRepairAndDecodeMicroseconds;
      resultConversionMicroseconds += converted.totalMicroseconds;
    } finally {
      segmentWall.stop();
      segmentWallMilliseconds.add(segmentWall.elapsedMicroseconds / 1000);
      stream.free();
    }
  }
  decode.stop();
  return _DecodeResult(
    text: texts.join(' '),
    tokens: tokens,
    decodeMilliseconds: decode.elapsedMicroseconds / 1000,
    segmentWallMilliseconds: segmentWallMilliseconds,
    nativeResultFetchMilliseconds: nativeResultFetchMicroseconds / 1000,
    ffiStringCopyMilliseconds: ffiStringCopyMicroseconds / 1000,
    jsonRepairAndDecodeMilliseconds: jsonRepairAndDecodeMicroseconds / 1000,
    resultConversionMilliseconds: resultConversionMicroseconds / 1000,
  );
}

_ConvertedResult _getQwen3Result(sherpa.OfflineStream stream) {
  final getResult = SherpaOnnxBindings.getOfflineStreamResultAsJson;
  final destroyResult = SherpaOnnxBindings.destroyOfflineStreamResultJson;
  if (getResult == null || destroyResult == null) {
    throw StateError('sherpa-onnx Qwen3 result bindings are unavailable');
  }
  final total = Stopwatch()..start();
  final nativeFetch = Stopwatch()..start();
  final pointer = getResult(stream.ptr);
  nativeFetch.stop();
  if (pointer == nullptr) {
    throw const FormatException('Qwen3 result JSON is missing');
  }
  try {
    final ffiCopy = Stopwatch()..start();
    final source = toDartString(pointer);
    ffiCopy.stop();
    final jsonDecode = Stopwatch()..start();
    final result = decodeQwen3ResultJson(source);
    jsonDecode.stop();
    total.stop();
    return _ConvertedResult(
      result: sherpa.OfflineRecognizerResult(
        text: result['text']! as String,
        tokens: List<String>.from(result['tokens']! as List),
        timestamps: List<double>.from(result['timestamps']! as List),
        lang: result['lang']! as String,
        emotion: result['emotion']! as String,
        event: result['event']! as String,
      ),
      nativeResultFetchMicroseconds: nativeFetch.elapsedMicroseconds,
      ffiStringCopyMicroseconds: ffiCopy.elapsedMicroseconds,
      jsonRepairAndDecodeMicroseconds: jsonDecode.elapsedMicroseconds,
      totalMicroseconds: total.elapsedMicroseconds,
    );
  } finally {
    destroyResult(pointer);
  }
}

String _runtimeRoot(List<String> arguments) {
  if (arguments.length != 2 || arguments.first != '--runtime-root') {
    throw const FormatException('expected --runtime-root PATH');
  }
  return arguments.last;
}

Map<String, Object?> _object(Map<String, Object?> source, String key) {
  final value = source[key];
  if (value is! Map) throw FormatException('$key must be an object');
  return Map<String, Object?>.from(value);
}

String _string(Map<String, Object?> source, String key) {
  final value = source[key];
  if (value is! String) throw FormatException('$key must be a string');
  return value;
}

int _integer(Map<String, Object?> source, String key) {
  final value = source[key];
  if (value is! int) throw FormatException('$key must be an integer');
  return value;
}

double _number(Map<String, Object?> source, String key) {
  final value = source[key];
  if (value is! num) throw FormatException('$key must be numeric');
  return value.toDouble();
}

Object? _objectValue(Object? value, String key) {
  if (value is! Map || !value.containsKey(key)) {
    throw FormatException('model file $key is missing');
  }
  return value[key];
}

String _modelPath(Map<String, Object?> modelFiles, String role) {
  final value = modelFiles[role];
  final path = _objectValue(value, 'path');
  if (path is! String) throw FormatException('$role path must be a string');
  return path;
}

Future<void> _emit(Map<String, Object?> event) async {
  stdout.writeln(jsonEncode(event));
  await stdout.flush();
}

class _Segment {
  const _Segment({required this.startSample, required this.samples});

  final int startSample;
  final Float32List samples;
}

class _ConvertedResult {
  const _ConvertedResult({
    required this.result,
    required this.nativeResultFetchMicroseconds,
    required this.ffiStringCopyMicroseconds,
    required this.jsonRepairAndDecodeMicroseconds,
    required this.totalMicroseconds,
  });

  final sherpa.OfflineRecognizerResult result;
  final int nativeResultFetchMicroseconds;
  final int ffiStringCopyMicroseconds;
  final int jsonRepairAndDecodeMicroseconds;
  final int totalMicroseconds;
}

class _DecodeResult {
  const _DecodeResult({
    required this.text,
    required this.tokens,
    required this.decodeMilliseconds,
    required this.segmentWallMilliseconds,
    required this.nativeResultFetchMilliseconds,
    required this.ffiStringCopyMilliseconds,
    required this.jsonRepairAndDecodeMilliseconds,
    required this.resultConversionMilliseconds,
  });

  final String text;
  final List<String> tokens;
  final double decodeMilliseconds;
  final List<double> segmentWallMilliseconds;
  final double nativeResultFetchMilliseconds;
  final double ffiStringCopyMilliseconds;
  final double jsonRepairAndDecodeMilliseconds;
  final double resultConversionMilliseconds;
}
