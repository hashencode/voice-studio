import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
// ignore: depend_on_referenced_packages
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

const int maximumWorkerLineBytes = 1024 * 1024;
const int maximumWorkerTextBytes = 64 * 1024;
const int liveCaptionSampleRate = 16000;
const int liveCaptionFrameSamples = 1600;

Future<void> main(List<String> arguments) async {
  _SenseVoiceRuntime? runtime;
  try {
    final options = _parseArguments(arguments);
    final control = SenseVoiceWorkerControl.fromJson(
      (jsonDecode(_required(options, 'control-json')) as Map)
          .cast<String, Object?>(),
      allowU18Optimization: options['profile-mode'] == 'u18-optimization',
    );
    final fixtureRoot = Directory(_required(options, 'fixture-root'));
    final model = await resolveContainedFile(
      File(_required(options, 'model')),
      Directory(_required(options, 'model-root')),
    );
    final tokens = await resolveContainedFile(
      File(_required(options, 'tokens')),
      Directory(_required(options, 'model-root')),
    );
    final vad = await resolveContainedFile(
      File(_required(options, 'vad')),
      Directory(_required(options, 'asset-root')),
    );
    await verifyFile(model, _required(options, 'model-sha256'));
    await verifyFile(tokens, _required(options, 'tokens-sha256'));
    await verifyFile(vad, _required(options, 'vad-sha256'));
    final load = Stopwatch()..start();
    sherpa.initBindings(_required(options, 'runtime-root'));
    runtime = _SenseVoiceRuntime(
      control: control,
      modelPath: model.path,
      tokensPath: tokens.path,
      vadPath: vad.path,
    );
    load.stop();
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': 'ready',
      'protocol': 'sensevoice-live-caption-worker/v1',
      'processId': pid,
      'modelLoadMs': load.elapsedMicroseconds / 1000,
      'residentBytes': ProcessInfo.currentRss,
      'effectiveConfig': control.toJson(),
      'publishesTokenPartials': false,
    });
    await for (final line
        in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
      if (utf8.encode(line).length > maximumWorkerLineBytes) {
        throw const FormatException('worker request line is too large');
      }
      final raw = jsonDecode(line);
      if (raw is! Map) {
        throw const FormatException('worker request must be an object');
      }
      final request = raw.cast<String, Object?>();
      if (request['type'] == 'shutdown') break;
      if (request['type'] == 'openSession') {
        final open = SenseVoiceSpoolOpenRequest.fromJson(request);
        final spool = await resolveContainedFile(
          File('${fixtureRoot.path}/${open.spoolRelativePath}'),
          fixtureRoot,
        );
        await runtime.openSession(
          open,
          spool: spool,
          modelSha256: _required(options, 'model-sha256'),
        );
        continue;
      }
      if (request['type'] == 'poll' || request['type'] == 'flush') {
        await runtime.pollSession(
          sessionId: request['sessionId'] as String? ?? '',
          flush: request['type'] == 'flush',
        );
        continue;
      }
      final decode = SenseVoiceDecodeRequest.fromJson(request);
      final source = await resolveContainedFile(
        File(decode.sourcePath),
        fixtureRoot,
      );
      await verifyFile(source, decode.sourceSha256);
      await runtime.decode(decode.copyWith(sourcePath: source.path));
    }
  } catch (error, stackTrace) {
    stderr
      ..writeln(error)
      ..writeln(stackTrace);
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': 'error',
      'code': switch (error) {
        FormatException() => 'INVALID_REQUEST',
        FileSystemException() => 'INVALID_ASSET',
        StateError() => 'DECODE_FAILED',
        _ => 'WORKER_FAILED',
      },
      'message': error.runtimeType.toString(),
    });
    exitCode = 1;
  } finally {
    runtime?.free();
  }
}

class SenseVoiceWorkerControl {
  SenseVoiceWorkerControl({
    required this.provider,
    required this.threads,
    required this.concurrency,
    required this.decodingMethod,
    required this.language,
    required this.useInverseTextNormalization,
    required this.recognizerLifecycle,
    required this.vadThreshold,
    required this.minimumSpeechSeconds,
    required this.minimumSilenceSeconds,
    required this.maximumUtteranceSeconds,
    required this.publishesTokenPartials,
    required this.publishesCompletedUtterancesOnly,
    this.allowU18Optimization = false,
  }) {
    final fixedInvariantsHold =
        provider == 'cpu' &&
        concurrency == 1 &&
        decodingMethod == 'greedy_search' &&
        recognizerLifecycle == 'resident_preloaded' &&
        !publishesTokenPartials &&
        publishesCompletedUtterancesOnly;
    final u13ControlHolds =
        threads == 2 &&
        language == 'auto' &&
        !useInverseTextNormalization &&
        vadThreshold == 0.5 &&
        minimumSpeechSeconds == 0.25 &&
        minimumSilenceSeconds == 0.5 &&
        maximumUtteranceSeconds == 15.0;
    final u18BoundsHold =
        const <int>{1, 2, 3}.contains(threads) &&
        const <String>{'auto', 'zh', 'en'}.contains(language) &&
        <double>{0.4, 0.5, 0.6}.contains(vadThreshold) &&
        <double>{0.15, 0.25}.contains(minimumSpeechSeconds) &&
        <double>{0.35, 0.5, 0.7}.contains(minimumSilenceSeconds) &&
        <double>{12.0, 15.0}.contains(maximumUtteranceSeconds);
    if (provider != 'cpu' ||
        !fixedInvariantsHold ||
        (!allowU18Optimization && !u13ControlHolds) ||
        (allowU18Optimization && !u18BoundsHold)) {
      throw FormatException(
        allowU18Optimization
            ? 'SenseVoice U18 profile escaped its registered bounds'
            : 'SenseVoice U13 control drifted',
      );
    }
  }

  factory SenseVoiceWorkerControl.fromJson(
    Map<String, Object?> json, {
    bool allowU18Optimization = false,
  }) {
    const fields = <String>{
      'provider',
      'threads',
      'concurrency',
      'decodingMethod',
      'language',
      'useInverseTextNormalization',
      'recognizerLifecycle',
      'vadThreshold',
      'minimumSpeechSeconds',
      'minimumSilenceSeconds',
      'maximumUtteranceSeconds',
      'publishesTokenPartials',
      'publishesCompletedUtterancesOnly',
    };
    if (json.keys.toSet().difference(fields).isNotEmpty ||
        fields.difference(json.keys.toSet()).isNotEmpty) {
      throw const FormatException('SenseVoice control fields changed');
    }
    return SenseVoiceWorkerControl(
      provider: json['provider']! as String,
      threads: json['threads']! as int,
      concurrency: json['concurrency']! as int,
      decodingMethod: json['decodingMethod']! as String,
      language: json['language']! as String,
      useInverseTextNormalization: json['useInverseTextNormalization']! as bool,
      recognizerLifecycle: json['recognizerLifecycle']! as String,
      vadThreshold: (json['vadThreshold']! as num).toDouble(),
      minimumSpeechSeconds: (json['minimumSpeechSeconds']! as num).toDouble(),
      minimumSilenceSeconds: (json['minimumSilenceSeconds']! as num).toDouble(),
      maximumUtteranceSeconds: (json['maximumUtteranceSeconds']! as num)
          .toDouble(),
      publishesTokenPartials: json['publishesTokenPartials']! as bool,
      publishesCompletedUtterancesOnly:
          json['publishesCompletedUtterancesOnly']! as bool,
      allowU18Optimization: allowU18Optimization,
    );
  }

  final String provider;
  final int threads;
  final int concurrency;
  final String decodingMethod;
  final String language;
  final bool useInverseTextNormalization;
  final String recognizerLifecycle;
  final double vadThreshold;
  final double minimumSpeechSeconds;
  final double minimumSilenceSeconds;
  final double maximumUtteranceSeconds;
  final bool publishesTokenPartials;
  final bool publishesCompletedUtterancesOnly;
  final bool allowU18Optimization;

  Map<String, Object?> toJson() => <String, Object?>{
    'provider': provider,
    'threads': threads,
    'concurrency': concurrency,
    'decodingMethod': decodingMethod,
    'language': language,
    'useInverseTextNormalization': useInverseTextNormalization,
    'recognizerLifecycle': recognizerLifecycle,
    'vadThreshold': vadThreshold,
    'minimumSpeechSeconds': minimumSpeechSeconds,
    'minimumSilenceSeconds': minimumSilenceSeconds,
    'maximumUtteranceSeconds': maximumUtteranceSeconds,
    'publishesTokenPartials': publishesTokenPartials,
    'publishesCompletedUtterancesOnly': publishesCompletedUtterancesOnly,
  };
}

class SenseVoiceDecodeRequest {
  SenseVoiceDecodeRequest({
    required this.requestId,
    required this.fixtureId,
    required this.sourcePath,
    required this.sourceSha256,
    required this.replayRealtime,
  }) {
    if (!_id.hasMatch(requestId) ||
        !_id.hasMatch(fixtureId) ||
        !_sha.hasMatch(sourceSha256)) {
      throw const FormatException('invalid live-caption decode identity');
    }
  }

  factory SenseVoiceDecodeRequest.fromJson(Map<String, Object?> json) {
    if (json['schemaVersion'] != 1 ||
        json['type'] != 'decode' ||
        json['requestId'] is! String ||
        json['fixtureId'] is! String ||
        json['sourcePath'] is! String ||
        json['sourceSha256'] is! String ||
        json['replayRealtime'] is! bool) {
      throw const FormatException('invalid live-caption decode request');
    }
    return SenseVoiceDecodeRequest(
      requestId: json['requestId']! as String,
      fixtureId: json['fixtureId']! as String,
      sourcePath: json['sourcePath']! as String,
      sourceSha256: json['sourceSha256']! as String,
      replayRealtime: json['replayRealtime']! as bool,
    );
  }

  final String requestId;
  final String fixtureId;
  final String sourcePath;
  final String sourceSha256;
  final bool replayRealtime;

  SenseVoiceDecodeRequest copyWith({required String sourcePath}) =>
      SenseVoiceDecodeRequest(
        requestId: requestId,
        fixtureId: fixtureId,
        sourcePath: sourcePath,
        sourceSha256: sourceSha256,
        replayRealtime: replayRealtime,
      );
}

class SenseVoiceSpoolOpenRequest {
  SenseVoiceSpoolOpenRequest({
    required this.sessionId,
    required this.generationId,
    required this.spoolRelativePath,
    required this.offsetBytes,
    required this.firstSequence,
  }) {
    if (!_id.hasMatch(sessionId) ||
        generationId <= 0 ||
        spoolRelativePath != 'caption/live-caption.pcmspool' ||
        offsetBytes < 0 ||
        offsetBytes.isOdd ||
        firstSequence <= 0) {
      throw const FormatException('invalid live-caption spool identity');
    }
  }

  factory SenseVoiceSpoolOpenRequest.fromJson(Map<String, Object?> json) {
    if (json['schemaVersion'] != 1 ||
        json['type'] != 'openSession' ||
        json['sessionId'] is! String ||
        json['generationId'] is! num ||
        json['spoolRelativePath'] is! String ||
        json['offsetBytes'] is! num ||
        json['firstSequence'] is! num) {
      throw const FormatException('invalid live-caption spool request');
    }
    return SenseVoiceSpoolOpenRequest(
      sessionId: json['sessionId']! as String,
      generationId: (json['generationId']! as num).toInt(),
      spoolRelativePath: json['spoolRelativePath']! as String,
      offsetBytes: (json['offsetBytes']! as num).toInt(),
      firstSequence: (json['firstSequence']! as num).toInt(),
    );
  }

  final String sessionId;
  final int generationId;
  final String spoolRelativePath;
  final int offsetBytes;
  final int firstSequence;
}

class _SenseVoiceRuntime {
  _SenseVoiceRuntime({
    required this.control,
    required String modelPath,
    required String tokensPath,
    required String vadPath,
  }) : recognizer = sherpa.OfflineRecognizer(
         sherpa.OfflineRecognizerConfig(
           model: sherpa.OfflineModelConfig(
             senseVoice: sherpa.OfflineSenseVoiceModelConfig(
               model: modelPath,
               language: control.language,
               useInverseTextNormalization: control.useInverseTextNormalization,
             ),
             tokens: tokensPath,
             numThreads: control.threads,
             provider: control.provider,
             debug: false,
           ),
           decodingMethod: control.decodingMethod,
         ),
       ),
       detector = sherpa.VoiceActivityDetector(
         config: sherpa.VadModelConfig(
           sileroVad: sherpa.SileroVadModelConfig(
             model: vadPath,
             threshold: control.vadThreshold,
             minSilenceDuration: control.minimumSilenceSeconds,
             minSpeechDuration: control.minimumSpeechSeconds,
             windowSize: 512,
             maxSpeechDuration: control.maximumUtteranceSeconds,
           ),
           sampleRate: liveCaptionSampleRate,
           numThreads: control.threads,
           provider: control.provider,
           debug: false,
         ),
         bufferSizeInSeconds: 60,
       );

  final SenseVoiceWorkerControl control;
  final sherpa.OfflineRecognizer recognizer;
  final sherpa.VoiceActivityDetector detector;
  _LiveSpoolState? _liveSession;

  Future<void> openSession(
    SenseVoiceSpoolOpenRequest request, {
    required File spool,
    required String modelSha256,
  }) async {
    final length = await spool.length();
    if (request.offsetBytes > length ||
        request.offsetBytes % (liveCaptionFrameSamples * 2) != 0 ||
        !_sha.hasMatch(modelSha256)) {
      throw const FormatException('live-caption offset escaped spool');
    }
    detector.reset();
    _liveSession = _LiveSpoolState(
      sessionId: request.sessionId,
      generationId: request.generationId,
      spool: spool,
      offsetBytes: request.offsetBytes,
      nextSequence: request.firstSequence,
      modelSha256: modelSha256,
    );
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': 'sessionReady',
      'sessionId': request.sessionId,
      'generationId': request.generationId,
      'offsetBytes': request.offsetBytes,
      'nextSequence': request.firstSequence,
      'modelSha256': modelSha256,
    });
  }

  Future<void> pollSession({
    required String sessionId,
    required bool flush,
  }) async {
    final live = _liveSession;
    if (live == null || live.sessionId != sessionId) {
      throw const FormatException('live-caption session mismatch');
    }
    final fileLength = await live.spool.length();
    final completeFrameBytes = liveCaptionFrameSamples * 2;
    final readableLength = fileLength - (fileLength % completeFrameBytes);
    if (readableLength < live.offsetBytes) {
      throw StateError('live-caption spool moved backwards');
    }
    const maximumPollBytes = liveCaptionSampleRate * 2 * 10;
    final endOffset = flush
        ? readableLength
        : min(readableLength, live.offsetBytes + maximumPollBytes);
    if (endOffset > live.offsetBytes) {
      final input = await live.spool.open();
      try {
        await input.setPosition(live.offsetBytes);
        final bytes = await input.read(endOffset - live.offsetBytes);
        if (bytes.length != endOffset - live.offsetBytes ||
            bytes.length % completeFrameBytes != 0) {
          throw StateError('live-caption spool read was not frame aligned');
        }
        final byteData = ByteData.sublistView(Uint8List.fromList(bytes));
        for (
          var byteOffset = 0;
          byteOffset < bytes.length;
          byteOffset += completeFrameBytes
        ) {
          final samples = Float32List(liveCaptionFrameSamples);
          for (var index = 0; index < liveCaptionFrameSamples; index += 1) {
            samples[index] =
                byteData.getInt16(byteOffset + index * 2, Endian.little) /
                32768.0;
          }
          detector.acceptWaveform(samples);
          live.offsetBytes += completeFrameBytes;
          while (!detector.isEmpty()) {
            final segment = detector.front();
            detector.pop();
            await _decodeLiveSegment(live, segment);
          }
        }
      } finally {
        await input.close();
      }
    }
    if (flush) {
      if (readableLength != fileLength) {
        throw StateError('live-caption spool ended with a partial frame');
      }
      detector.flush();
      while (!detector.isEmpty()) {
        final segment = detector.front();
        detector.pop();
        await _decodeLiveSegment(live, segment);
      }
    }
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': flush ? 'sessionComplete' : 'pollComplete',
      'sessionId': live.sessionId,
      'generationId': live.generationId,
      'offsetBytes': live.offsetBytes,
      'nextSequence': live.nextSequence,
      'backlogBytes': max(0, readableLength - live.offsetBytes),
      'residentBytes': ProcessInfo.currentRss,
    });
  }

  Future<void> _decodeLiveSegment(
    _LiveSpoolState live,
    sherpa.SpeechSegment segment,
  ) async {
    final maximumSamples =
        (control.maximumUtteranceSeconds * liveCaptionSampleRate).round();
    for (final range in hardSplitRanges(
      segment.samples.length,
      maximumSamples,
    )) {
      final samples = Float32List.sublistView(
        segment.samples,
        range.start,
        range.end,
      );
      final stream = recognizer.createStream();
      try {
        stream.acceptWaveform(
          samples: samples,
          sampleRate: liveCaptionSampleRate,
        );
        recognizer.decode(stream);
        final result = recognizer.getResult(stream);
        final textBytes = utf8.encode(result.text);
        if (textBytes.length > maximumWorkerTextBytes) {
          throw const FormatException('worker result text is too large');
        }
        final startSample = segment.start + range.start;
        await emitWorkerEvent(<String, Object?>{
          'schemaVersion': 1,
          'type': 'utterance',
          'sessionId': live.sessionId,
          'generationId': live.generationId,
          'sequence': live.nextSequence,
          'startSeconds': startSample / liveCaptionSampleRate,
          'endSeconds': (startSample + samples.length) / liveCaptionSampleRate,
          'text': result.text,
          'textSha256': sha256.convert(textBytes).toString(),
          'language': result.lang.isEmpty ? 'und' : result.lang,
          'event': result.event,
          'offsetBytes': live.offsetBytes,
          'modelSha256': live.modelSha256,
          'residentBytes': ProcessInfo.currentRss,
        });
        live.nextSequence += 1;
      } finally {
        stream.free();
      }
    }
  }

  Future<void> decode(SenseVoiceDecodeRequest request) async {
    final wave = sherpa.readWave(request.sourcePath);
    if (wave.sampleRate != liveCaptionSampleRate || wave.samples.isEmpty) {
      throw const FormatException('source must be non-empty mono 16 kHz PCM');
    }
    final startedAtEpochUs = DateTime.now().microsecondsSinceEpoch;
    final wall = Stopwatch()..start();
    detector.reset();
    var utteranceCount = 0;
    var maximumQueuedSeconds = 0.0;
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': 'fixtureStart',
      'requestId': request.requestId,
      'fixtureId': request.fixtureId,
      'audioDurationSeconds': wave.samples.length / wave.sampleRate,
      'replayRealtime': request.replayRealtime,
    });
    for (
      var offset = 0;
      offset < wave.samples.length;
      offset += liveCaptionFrameSamples
    ) {
      final end = min(offset + liveCaptionFrameSamples, wave.samples.length);
      detector.acceptWaveform(
        Float32List.sublistView(wave.samples, offset, end),
      );
      if (request.replayRealtime) {
        final target = Duration(
          microseconds: (end * Duration.microsecondsPerSecond / wave.sampleRate)
              .round(),
        );
        final remaining = target - wall.elapsed;
        if (remaining > Duration.zero) await Future<void>.delayed(remaining);
      }
      while (!detector.isEmpty()) {
        final segment = detector.front();
        detector.pop();
        maximumQueuedSeconds = max(
          maximumQueuedSeconds,
          max(0, end - segment.start - segment.samples.length) /
              liveCaptionSampleRate,
        );
        utteranceCount += await _decodeSegment(
          request: request,
          segment: segment,
          firstSequence: utteranceCount + 1,
          startedAtEpochUs: startedAtEpochUs,
        );
      }
    }
    detector.flush();
    while (!detector.isEmpty()) {
      final segment = detector.front();
      detector.pop();
      utteranceCount += await _decodeSegment(
        request: request,
        segment: segment,
        firstSequence: utteranceCount + 1,
        startedAtEpochUs: startedAtEpochUs,
      );
    }
    wall.stop();
    await emitWorkerEvent(<String, Object?>{
      'schemaVersion': 1,
      'type': 'fixtureComplete',
      'requestId': request.requestId,
      'fixtureId': request.fixtureId,
      'utteranceCount': utteranceCount,
      'inputSamples': wave.samples.length,
      'consumedSamples': wave.samples.length,
      'maximumQueuedSeconds': maximumQueuedSeconds,
      'wallMilliseconds': wall.elapsedMicroseconds / 1000,
      'residentBytes': ProcessInfo.currentRss,
      'tokenPartialCount': 0,
    });
  }

  Future<int> _decodeSegment({
    required SenseVoiceDecodeRequest request,
    required sherpa.SpeechSegment segment,
    required int firstSequence,
    required int startedAtEpochUs,
  }) async {
    final maximumSamples =
        (control.maximumUtteranceSeconds * liveCaptionSampleRate).round();
    var emitted = 0;
    for (final range in hardSplitRanges(
      segment.samples.length,
      maximumSamples,
    )) {
      await _decodeChunk(
        request: request,
        samples: Float32List.sublistView(
          segment.samples,
          range.start,
          range.end,
        ),
        startSample: segment.start + range.start,
        sequence: firstSequence + emitted,
        startedAtEpochUs: startedAtEpochUs,
      );
      emitted += 1;
    }
    return emitted;
  }

  Future<void> _decodeChunk({
    required SenseVoiceDecodeRequest request,
    required Float32List samples,
    required int startSample,
    required int sequence,
    required int startedAtEpochUs,
  }) async {
    final stream = recognizer.createStream();
    final decode = Stopwatch()..start();
    try {
      stream.acceptWaveform(
        samples: samples,
        sampleRate: liveCaptionSampleRate,
      );
      recognizer.decode(stream);
      final result = recognizer.getResult(stream);
      decode.stop();
      final startSeconds = startSample / liveCaptionSampleRate;
      final endSeconds = (startSample + samples.length) / liveCaptionSampleRate;
      final textBytes = utf8.encode(result.text);
      if (textBytes.length > maximumWorkerTextBytes) {
        throw const FormatException('worker result text is too large');
      }
      await emitWorkerEvent(<String, Object?>{
        'schemaVersion': 1,
        'type': 'utterance',
        'requestId': request.requestId,
        'fixtureId': request.fixtureId,
        'sequence': sequence,
        'startSeconds': startSeconds,
        'endSeconds': endSeconds,
        'text': result.text,
        'textSha256': sha256.convert(textBytes).toString(),
        'language': result.lang,
        'event': result.event,
        'decodeMilliseconds': decode.elapsedMicroseconds / 1000,
        'speechEndEpochUs':
            startedAtEpochUs +
            (endSeconds * Duration.microsecondsPerSecond).round(),
        'workerResultEpochUs': DateTime.now().microsecondsSinceEpoch,
        'residentBytes': ProcessInfo.currentRss,
      });
    } finally {
      stream.free();
    }
  }

  void free() {
    detector.free();
    recognizer.free();
  }
}

class _LiveSpoolState {
  _LiveSpoolState({
    required this.sessionId,
    required this.generationId,
    required this.spool,
    required this.offsetBytes,
    required this.nextSequence,
    required this.modelSha256,
  });

  final String sessionId;
  final int generationId;
  final File spool;
  int offsetBytes;
  int nextSequence;
  final String modelSha256;
}

List<({int start, int end})> hardSplitRanges(
  int sampleCount,
  int maximumSamples,
) {
  if (sampleCount < 0 || maximumSamples <= 0) {
    throw const FormatException('invalid hard split bounds');
  }
  return <({int start, int end})>[
    for (var start = 0; start < sampleCount; start += maximumSamples)
      (start: start, end: min(start + maximumSamples, sampleCount)),
  ];
}

Future<File> resolveContainedFile(File file, Directory root) async {
  final resolvedRoot = await root.resolveSymbolicLinks();
  final resolvedFile = await file.resolveSymbolicLinks();
  final prefix = resolvedRoot.endsWith(Platform.pathSeparator)
      ? resolvedRoot
      : '$resolvedRoot${Platform.pathSeparator}';
  if (!resolvedFile.startsWith(prefix) || !await File(resolvedFile).exists()) {
    throw const FileSystemException('file escapes its declared root');
  }
  return File(resolvedFile);
}

Future<void> verifyFile(File file, String expectedSha256) async {
  if (!_sha.hasMatch(expectedSha256)) {
    throw const FormatException('expected file hash is invalid');
  }
  final digest = (await sha256.bind(file.openRead()).first).toString();
  if (digest != expectedSha256) {
    throw const FileSystemException('file hash drifted');
  }
}

Future<void> emitWorkerEvent(Map<String, Object?> event) async {
  final line = jsonEncode(event);
  if (utf8.encode(line).length > maximumWorkerLineBytes) {
    throw const FormatException('worker event is too large');
  }
  stdout.writeln(line);
  await stdout.flush();
}

Map<String, String> _parseArguments(List<String> arguments) {
  final result = <String, String>{};
  for (final argument in arguments) {
    if (!argument.startsWith('--') || !argument.contains('=')) {
      throw const FormatException('worker arguments must be --key=value');
    }
    final separator = argument.indexOf('=');
    final key = argument.substring(2, separator);
    final value = argument.substring(separator + 1);
    if (key.isEmpty || value.isEmpty || result.containsKey(key)) {
      throw const FormatException('invalid or duplicate worker argument');
    }
    result[key] = value;
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

final _id = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
final _sha = RegExp(r'^[0-9a-f]{64}$');
