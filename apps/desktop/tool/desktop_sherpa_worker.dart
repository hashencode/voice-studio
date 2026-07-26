import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

Future<void> main(List<String> arguments) async {
  try {
    final options = _parse(arguments);
    final phase = _required(options, 'phase');
    final requestLine = await stdin
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .first;
    final request = jsonDecode(requestLine);
    if (request is! Map<String, Object?> ||
        request['schemaVersion'] != 1 ||
        request['sourcePath'] is! String ||
        request['sourceSha256'] is! String) {
      throw const FormatException('invalid worker request');
    }
    final source = File(request['sourcePath']! as String);
    final expectedSha = request['sourceSha256']! as String;
    if (!await source.exists() || await _sha256(source) != expectedSha) {
      throw const FormatException('source identity mismatch');
    }
    sherpa.initBindings(_required(options, 'runtime-root'));
    final wave = sherpa.readWave(source.path);
    if (wave.samples.isEmpty || wave.sampleRate != 16000) {
      throw const FormatException('source must decode to mono 16 kHz PCM');
    }
    if (phase == 'asr') {
      await _asr(options, request, wave);
    } else if (phase == 'diarization') {
      await _diarization(options, request, wave);
    } else {
      throw const FormatException('unsupported worker phase');
    }
  } catch (error) {
    _emit(<String, Object?>{
      'schemaVersion': 1,
      'type': 'error',
      'code': 'NATIVE_WORKER_FAILED',
      'message': error.runtimeType.toString(),
    });
    exitCode = 1;
  }
}

Future<void> _asr(
  Map<String, String> options,
  Map<String, Object?> request,
  sherpa.WaveData wave,
) async {
  final numThreads = _numThreads(options);
  final recognizer = sherpa.OnlineRecognizer(
    sherpa.OnlineRecognizerConfig(
      model: sherpa.OnlineModelConfig(
        transducer: sherpa.OnlineTransducerModelConfig(
          encoder: _required(options, 'encoder'),
          decoder: _required(options, 'decoder'),
          joiner: _required(options, 'joiner'),
        ),
        tokens: _required(options, 'tokens'),
        numThreads: numThreads,
        debug: false,
        provider: 'cpu',
        modelType: 'zipformer',
        modelingUnit: 'char',
      ),
      enableEndpoint: false,
    ),
  );
  final stream = recognizer.createStream();
  try {
    final chunkSamples = max(1, wave.sampleRate ~/ 10);
    for (var offset = 0; offset < wave.samples.length; offset += chunkSamples) {
      final end = min(offset + chunkSamples, wave.samples.length);
      stream.acceptWaveform(
        samples: Float32List.sublistView(wave.samples, offset, end),
        sampleRate: wave.sampleRate,
      );
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      if (offset % (chunkSamples * 20) == 0) {
        _progress('asr', 0.45 * end / wave.samples.length);
      }
    }
    stream.inputFinished();
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
    final result = recognizer.getResult(stream);
    if (result.text.trim().isEmpty) {
      throw StateError('empty transcript');
    }
    _emit(<String, Object?>{
      'schemaVersion': 1,
      'type': 'result',
      'phase': 'asr',
      'sourceSha256': request['sourceSha256'],
      'text': result.text,
      'tokens': result.tokens,
      'timestamps': result.timestamps,
      'durationSeconds': wave.samples.length / wave.sampleRate,
      'residentBytes': ProcessInfo.currentRss,
    });
  } finally {
    stream.free();
    recognizer.free();
  }
}

Future<void> _diarization(
  Map<String, String> options,
  Map<String, Object?> request,
  sherpa.WaveData wave,
) async {
  final threshold = double.parse(_required(options, 'diarization-threshold'));
  if (!threshold.isFinite || threshold <= 0 || threshold >= 1) {
    throw const FormatException('invalid diarization threshold');
  }
  final numThreads = _numThreads(options);
  final startSeconds = double.tryParse(options['start-seconds'] ?? '') ?? 0;
  final endSeconds =
      double.tryParse(options['end-seconds'] ?? '') ??
      wave.samples.length / wave.sampleRate;
  final durationSeconds = wave.samples.length / wave.sampleRate;
  if (!startSeconds.isFinite ||
      !endSeconds.isFinite ||
      startSeconds < 0 ||
      endSeconds <= startSeconds ||
      endSeconds > durationSeconds) {
    throw const FormatException('invalid diarization shard range');
  }
  final startSample = (startSeconds * wave.sampleRate).round().clamp(
    0,
    wave.samples.length,
  );
  final endSample = (endSeconds * wave.sampleRate).round().clamp(
    startSample + 1,
    wave.samples.length,
  );
  final shardSamples = Float32List.sublistView(
    wave.samples,
    startSample,
    endSample,
  );
  final diarizer = sherpa.OfflineSpeakerDiarization(
    sherpa.OfflineSpeakerDiarizationConfig(
      segmentation: sherpa.OfflineSpeakerSegmentationModelConfig(
        pyannote: sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(
          model: _required(options, 'segmentation'),
        ),
        numThreads: numThreads,
        debug: false,
      ),
      embedding: sherpa.SpeakerEmbeddingExtractorConfig(
        model: _required(options, 'embedding'),
        numThreads: numThreads,
        debug: false,
      ),
      clustering: sherpa.FastClusteringConfig(
        numClusters: -1,
        threshold: threshold,
      ),
    ),
  );
  try {
    final result = diarizer.processWithCallback(
      samples: shardSamples,
      callback: (processed, total) {
        _progress('diarization', 0.45 + 0.5 * processed / max(1, total));
        return 1;
      },
    );
    _emit(<String, Object?>{
      'schemaVersion': 1,
      'type': 'result',
      'phase': 'diarization',
      'sourceSha256': request['sourceSha256'],
      'turns': result
          .map(
            (segment) => <String, Object?>{
              'startSeconds': segment.start + startSeconds,
              'endSeconds': segment.end + startSeconds,
              'speakerKey':
                  'speaker_${(segment.speaker + 1).toString().padLeft(2, '0')}',
            },
          )
          .toList(growable: false),
      'residentBytes': ProcessInfo.currentRss,
      'shardStartSeconds': startSeconds,
      'shardEndSeconds': endSeconds,
    });
  } finally {
    diarizer.free();
  }
}

int _numThreads(Map<String, String> options) {
  final value = int.parse(_required(options, 'num-threads'));
  if (value <= 0 || value > 8) {
    throw const FormatException('invalid worker thread count');
  }
  return value;
}

void _progress(String phase, double fraction) {
  _emit(<String, Object?>{
    'schemaVersion': 1,
    'type': 'progress',
    'phase': phase,
    'fraction': fraction.clamp(0.0, 1.0),
  });
}

void _emit(Map<String, Object?> value) {
  stdout.writeln(jsonEncode(value));
}

Map<String, String> _parse(List<String> arguments) {
  if (arguments.length.isOdd) {
    throw const FormatException('worker arguments must be key/value pairs');
  }
  final output = <String, String>{};
  for (var index = 0; index < arguments.length; index += 2) {
    final key = arguments[index];
    if (!key.startsWith('--')) throw const FormatException('invalid argument');
    output[key.substring(2)] = arguments[index + 1];
  }
  return output;
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
