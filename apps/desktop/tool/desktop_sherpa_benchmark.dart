import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
// ignore: depend_on_referenced_packages
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

Future<void> main(List<String> arguments) async {
  final options = _parse(arguments);
  final outputRoot = Directory(_required(options, 'output-root'));
  await outputRoot.create(recursive: true);
  final runtimeRoot = _required(options, 'runtime-root');
  stderr.writeln('desktop-benchmark: loading Sherpa runtime');
  sherpa.initBindings(runtimeRoot);
  stderr.writeln('desktop-benchmark: Sherpa runtime loaded');

  final fingerprint = await _fingerprint(
    '$runtimeRoot/libsherpa-onnx-c-api.dylib',
  );
  final common = <String, Object?>{
    'schemaVersion': 1,
    'contractId': _required(options, 'contract-id'),
    'source': 'macos_native_sherpa',
    'complete': true,
    'timedOut': false,
    'cancelled': false,
    'temporaryArtifactsReleased': true,
    'targetFingerprint': fingerprint,
  };
  final probes = (options['probes'] ?? 'asr,functional,resource')
      .split(',')
      .toSet();
  if (probes.contains('asr')) {
    stderr.writeln('desktop-benchmark: starting ASR');
    final asr = await _runAsr(options, common);
    stderr.writeln('desktop-benchmark: ASR complete');
    await _writeJson(File('${outputRoot.path}/asr.json'), asr);
  }
  if (probes.contains('functional')) {
    stderr.writeln('desktop-benchmark: starting functional diarization');
    final functional = await _runDiarization(
      options: options,
      common: common,
      probe: 'diarization-functional',
      wavKey: 'speaker-functional',
      fixtureId: 'fixed-speaker-functional-5m',
      fixtureSha256:
          '7e2757eb30176edc36a2c14a6511bbf297caa5dbfa9541e119cd94fd23a6d4ec',
    );
    await _writeJson(
      File('${outputRoot.path}/diarization-functional.json'),
      functional,
    );
    stderr.writeln('desktop-benchmark: functional diarization complete');
  }
  if (probes.contains('resource')) {
    stderr.writeln('desktop-benchmark: starting 120-minute resource probe');
    final resource = await _runDiarization(
      options: options,
      common: common,
      probe: 'diarization-resource',
      wavKey: 'speaker-resource',
      fixtureId: 'fixed-speaker-resource-120m',
      fixtureSha256:
          '6a4f0849cee47ad9daecac04d92977c8cf6b48de1dd43849ad60852de5b336c3',
    );
    await _writeJson(
      File('${outputRoot.path}/diarization-resource.json'),
      resource,
    );
    stderr.writeln('desktop-benchmark: 120-minute resource probe complete');
  }

  final hashes = <String, String>{};
  for (final name in <String>[
    'asr',
    'diarization-functional',
    'diarization-resource',
  ]) {
    final file = File('${outputRoot.path}/$name.json');
    if (!file.existsSync()) {
      stderr.writeln('desktop-benchmark: partial probe set complete');
      return;
    }
    hashes[name] = await _sha256(file);
  }
  await _writeJson(File('${outputRoot.path}/index.json'), <String, Object?>{
    'schemaVersion': 1,
    'contractId': _required(options, 'contract-id'),
    'evidenceSha256': hashes,
  });
}

Future<Map<String, Object?>> _runAsr(
  Map<String, String> options,
  Map<String, Object?> common,
) async {
  final wavFile = File(_required(options, 'asr-wav'));
  final encoderFile = File(_required(options, 'asr-encoder'));
  final decoderFile = File(_required(options, 'asr-decoder'));
  final joinerFile = File(_required(options, 'asr-joiner'));
  final tokensFile = File(_required(options, 'asr-tokens'));
  await _verify(
    wavFile,
    '9345f80fc835ae2afc9bb58ccdbd5047797d7de3afc4cb3a2c6ef44444a2a562',
  );
  await _verify(
    encoderFile,
    '1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1',
  );
  await _verify(
    decoderFile,
    '22f123bb8cba9b38974b3df18a3f45e7081f4985ebb2e075d9f21f618c468bbf',
  );
  await _verify(
    joinerFile,
    'a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169',
  );
  await _verify(
    tokensFile,
    '8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac',
  );
  final wave = sherpa.readWave(wavFile.path);
  if (wave.samples.isEmpty || wave.sampleRate <= 0) {
    throw StateError('ASR fixture cannot be decoded');
  }
  final duration = wave.samples.length / wave.sampleRate;
  final numThreads = int.tryParse(options['num-threads'] ?? '') ?? 2;
  final started = Stopwatch()..start();
  final recognizer = sherpa.OnlineRecognizer(
    sherpa.OnlineRecognizerConfig(
      model: sherpa.OnlineModelConfig(
        transducer: sherpa.OnlineTransducerModelConfig(
          encoder: encoderFile.path,
          decoder: decoderFile.path,
          joiner: joinerFile.path,
        ),
        tokens: tokensFile.path,
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
  stream.acceptWaveform(samples: wave.samples, sampleRate: wave.sampleRate);
  stream.inputFinished();
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }
  final result = recognizer.getResult(stream);
  stream.free();
  recognizer.free();
  started.stop();
  final reference = await File(
    _required(options, 'asr-reference'),
  ).readAsString();
  final cer = _cer(reference, result.text);
  return <String, Object?>{
    ...common,
    'probe': 'asr',
    'models': <Object?>[
      <String, Object?>{
        'id': 'sherpa-streaming-zipformer-zh-14m-2023-02-23',
        'version': '2023-02-23',
        'sha256': await _combinedSha256(<File>[
          encoderFile,
          decoderFile,
          joinerFile,
        ]),
        'componentSha256': <String, Object?>{
          'encoder': await _sha256(encoderFile),
          'decoder': await _sha256(decoderFile),
          'joiner': await _sha256(joinerFile),
        },
        'licenseDisposition': 'APACHE_2_0_ARCHIVE_README_PINNED',
      },
    ],
    'fixture': <String, Object?>{
      'id': 'fixed-zh-meeting-300s',
      'sha256': await _sha256(wavFile),
      'durationSeconds': duration,
    },
    'configuration': <String, Object?>{'numThreads': numThreads},
    'segments': <Object?>[
      <String, Object?>{
        'startSeconds': 0.0,
        'endSeconds': duration,
        'text': result.text,
      },
    ],
    'tokenTimestampCount': result.timestamps.length,
    'metrics': <String, Object?>{
      'elapsedMilliseconds': started.elapsedMilliseconds,
      'rtf': started.elapsedMilliseconds / 1000 / duration,
      'cer': cer,
      'residentBytesAfterProbe': ProcessInfo.currentRss,
    },
  };
}

Future<Map<String, Object?>> _runDiarization({
  required Map<String, String> options,
  required Map<String, Object?> common,
  required String probe,
  required String wavKey,
  required String fixtureId,
  required String fixtureSha256,
}) async {
  final wavFile = File(_required(options, wavKey));
  final segmentation = File(_required(options, 'segmentation-model'));
  final embedding = File(_required(options, 'embedding-model'));
  await _verify(wavFile, fixtureSha256);
  await _verify(
    segmentation,
    '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  );
  await _verify(
    embedding,
    '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
  );
  final rssBefore = ProcessInfo.currentRss;
  var peakSampledRss = rssBefore;
  final numThreads = int.tryParse(options['num-threads'] ?? '') ?? 2;
  final wave = sherpa.readWave(wavFile.path);
  if (wave.samples.isEmpty || wave.sampleRate != 16000) {
    throw StateError('$probe fixture cannot be decoded as 16 kHz PCM');
  }
  final duration = wave.samples.length / wave.sampleRate;
  final diarizer = sherpa.OfflineSpeakerDiarization(
    sherpa.OfflineSpeakerDiarizationConfig(
      segmentation: sherpa.OfflineSpeakerSegmentationModelConfig(
        pyannote: sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(
          model: segmentation.path,
        ),
        numThreads: numThreads,
        debug: false,
      ),
      embedding: sherpa.SpeakerEmbeddingExtractorConfig(
        model: embedding.path,
        numThreads: numThreads,
        debug: false,
      ),
      clustering: const sherpa.FastClusteringConfig(
        numClusters: 2,
        threshold: 0.5,
      ),
    ),
  );
  var callbackCount = 0;
  final started = Stopwatch()..start();
  stderr.writeln('desktop-benchmark: native diarizer initialized');
  final segments = diarizer.processWithCallback(
    samples: wave.samples,
    callback: (processed, total) {
      callbackCount += 1;
      peakSampledRss = max(peakSampledRss, ProcessInfo.currentRss);
      // Sherpa 1.13.4 ignores this callback's return value. It is a progress
      // hook only; cancellation is enforced by terminating an isolated worker.
      return 1;
    },
  );
  diarizer.free();
  started.stop();
  final rssAfter = ProcessInfo.currentRss;
  peakSampledRss = max(peakSampledRss, rssAfter);
  final silenceRegions = probe == 'diarization-functional'
      ? _detectSilence(wave.samples, wave.sampleRate)
      : const <_Interval>[];
  final postprocessedSegments = probe == 'diarization-functional'
      ? _subtractIntervals(segments, silenceRegions)
      : segments;
  final encodedSegments = postprocessedSegments
      .map(
        (segment) => <String, Object?>{
          'startSeconds': segment.start,
          'endSeconds': segment.end,
          'speakerKey':
              'speaker_${(segment.speaker + 1).toString().padLeft(2, '0')}',
        },
      )
      .toList(growable: false);
  final result = <String, Object?>{
    ...common,
    'complete': segments.isNotEmpty,
    'timedOut': false,
    'probe': probe,
    'models': <Object?>[
      <String, Object?>{
        'id': 'sherpa-pyannote-segmentation-3.0',
        'version': '3.0',
        'sha256': await _sha256(segmentation),
        'licenseDisposition': 'UPSTREAM_REVIEWED_BENCHMARK_ONLY',
      },
      <String, Object?>{
        'id': '3dspeaker-eres2net-base-zh-16k',
        'version': 'upstream-pinned',
        'sha256': await _sha256(embedding),
        'licenseDisposition': 'UPSTREAM_REVIEWED_BENCHMARK_ONLY',
      },
    ],
    'fixture': <String, Object?>{
      'id': fixtureId,
      'sha256': await _sha256(wavFile),
      'durationSeconds': duration,
    },
    'callbackCount': callbackCount,
    'configuration': <String, Object?>{
      'numThreads': numThreads,
      'peakRssSampling': 'every_native_progress_callback',
    },
    'metrics': <String, Object?>{
      'elapsedMilliseconds': started.elapsedMilliseconds,
      'rtf': started.elapsedMilliseconds / 1000 / duration,
      'residentBytesBeforeProbe': rssBefore,
      'peakSampledResidentBytes': peakSampledRss,
      'incrementalPeakRssBytes': max(0, peakSampledRss - rssBefore),
      'residentBytesAfterProbe': rssAfter,
    },
  };
  if (probe == 'diarization-functional') {
    result['segments'] = encodedSegments;
    result['silenceSuppression'] = <String, Object?>{
      'method': 'pcm_max_abs_20ms',
      'threshold': 0.0005,
      'minimumDurationSeconds': 0.2,
      'detectedRegionCount': silenceRegions.length,
      'speakerOverlapSecondsAfterSuppression': _speakerOverlapSeconds(
        postprocessedSegments,
        silenceRegions,
      ),
    };
  } else {
    result['completedFullDuration'] = segments.isNotEmpty;
    result['oom'] = false;
    result['segmentCount'] = segments.length;
  }
  return result;
}

List<_Interval> _detectSilence(Float32List samples, int sampleRate) {
  final window = max(1, sampleRate ~/ 50);
  final minimumSamples = (sampleRate * 0.2).round();
  final regions = <_Interval>[];
  int? silentStart;
  for (var offset = 0; offset < samples.length; offset += window) {
    final end = min(offset + window, samples.length);
    var maximum = 0.0;
    for (var index = offset; index < end; index += 1) {
      maximum = max(maximum, samples[index].abs());
    }
    if (maximum <= 0.0005) {
      silentStart ??= offset;
    } else if (silentStart != null) {
      if (offset - silentStart >= minimumSamples) {
        regions.add(_Interval(silentStart / sampleRate, offset / sampleRate));
      }
      silentStart = null;
    }
  }
  if (silentStart != null && samples.length - silentStart >= minimumSamples) {
    regions.add(
      _Interval(silentStart / sampleRate, samples.length / sampleRate),
    );
  }
  return regions;
}

List<sherpa.OfflineSpeakerDiarizationSegment> _subtractIntervals(
  List<sherpa.OfflineSpeakerDiarizationSegment> segments,
  List<_Interval> exclusions,
) {
  final output = <sherpa.OfflineSpeakerDiarizationSegment>[];
  for (final segment in segments) {
    var pieces = <_Interval>[_Interval(segment.start, segment.end)];
    for (final exclusion in exclusions) {
      final next = <_Interval>[];
      for (final piece in pieces) {
        if (exclusion.end <= piece.start || exclusion.start >= piece.end) {
          next.add(piece);
          continue;
        }
        if (exclusion.start > piece.start) {
          next.add(_Interval(piece.start, exclusion.start));
        }
        if (exclusion.end < piece.end) {
          next.add(_Interval(exclusion.end, piece.end));
        }
      }
      pieces = next;
    }
    output.addAll(
      pieces
          .where((piece) => piece.end - piece.start >= 0.02)
          .map(
            (piece) => sherpa.OfflineSpeakerDiarizationSegment(
              start: piece.start,
              end: piece.end,
              speaker: segment.speaker,
            ),
          ),
    );
  }
  output.sort((left, right) => left.start.compareTo(right.start));
  return output;
}

double _speakerOverlapSeconds(
  List<sherpa.OfflineSpeakerDiarizationSegment> segments,
  List<_Interval> silence,
) {
  var total = 0.0;
  for (final segment in segments) {
    for (final region in silence) {
      total += max(
        0,
        min(segment.end, region.end) - max(segment.start, region.start),
      );
    }
  }
  return total;
}

class _Interval {
  const _Interval(this.start, this.end);

  final double start;
  final double end;
}

Map<String, String> _parse(List<String> arguments) {
  final values = <String, String>{};
  for (var index = 0; index < arguments.length; index += 2) {
    if (index + 1 >= arguments.length || !arguments[index].startsWith('--')) {
      throw ArgumentError('expected --key value arguments');
    }
    values[arguments[index].substring(2)] = arguments[index + 1];
  }
  return values;
}

String _required(Map<String, String> options, String key) {
  final value = options[key];
  if (value == null || value.isEmpty) throw ArgumentError('missing --$key');
  return value;
}

Future<Map<String, Object?>> _fingerprint(String runtimePath) async {
  String command(String executable, List<String> arguments) {
    final result = Process.runSync(executable, arguments);
    if (result.exitCode != 0) throw StateError('$executable failed');
    return (result.stdout as String).trim();
  }

  return <String, Object?>{
    'operatingSystem': 'macos',
    'operatingSystemVersion': command('/usr/bin/sw_vers', <String>[
      '-productVersion',
    ]),
    'architecture': command('/usr/bin/uname', <String>['-m']),
    'cpuModel': command('/usr/sbin/sysctl', <String>[
      '-n',
      'machdep.cpu.brand_string',
    ]),
    'logicalCpuCount': int.parse(
      command('/usr/sbin/sysctl', <String>['-n', 'hw.logicalcpu']),
    ),
    'memoryBytes': int.parse(
      command('/usr/sbin/sysctl', <String>['-n', 'hw.memsize']),
    ),
    'runtimeId': 'sherpa-onnx-c-api',
    'runtimeVersion': '1.13.4',
    'runtimeSha256': await _sha256(File(runtimePath)),
  };
}

Future<void> _verify(File file, String expected) async {
  if (!await file.exists()) throw StateError('missing benchmark input');
  if (await _sha256(file) != expected) {
    throw StateError('benchmark input hash mismatch');
  }
}

Future<String> _sha256(File file) async {
  return (await sha256.bind(file.openRead()).first).toString();
}

Future<String> _combinedSha256(List<File> files) async {
  return (await sha256.bind(_fileChunks(files)).first).toString();
}

Stream<List<int>> _fileChunks(List<File> files) async* {
  for (final file in files) {
    yield* file.openRead();
  }
}

Future<void> _writeJson(File file, Map<String, Object?> value) async {
  await file.writeAsString(
    '${const JsonEncoder.withIndent('  ').convert(value)}\n',
    flush: true,
  );
}

double _cer(String reference, String hypothesis) {
  final left = reference.toLowerCase().runes.where(_isAlphanumeric).toList();
  final right = hypothesis.toLowerCase().runes.where(_isAlphanumeric).toList();
  if (left.isEmpty) throw StateError('ASR reference is empty');
  var previous = List<int>.generate(right.length + 1, (index) => index);
  for (var row = 1; row <= left.length; row += 1) {
    final current = <int>[row];
    for (var column = 1; column <= right.length; column += 1) {
      current.add(
        min(
          min(current[column - 1] + 1, previous[column] + 1),
          previous[column - 1] + (left[row - 1] == right[column - 1] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous.last / left.length;
}

bool _isAlphanumeric(int rune) {
  return (rune >= 0x30 && rune <= 0x39) ||
      (rune >= 0x41 && rune <= 0x5a) ||
      (rune >= 0x61 && rune <= 0x7a) ||
      (rune >= 0x3400 && rune <= 0x9fff);
}
