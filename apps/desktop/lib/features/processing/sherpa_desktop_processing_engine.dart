import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:processing_contracts/processing_contracts.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'qwen3_result.dart';
import 'sherpa_runtime_probe.dart';

const int frozenQwen3MaxTotalLen = 512;
const int frozenQwen3MaxNewTokens = 512;
const double frozenQwen3Temperature = 0.000001;
const double frozenQwen3TopP = 0.8;
const int frozenQwen3Seed = 42;
const String frozenQwen3Hotwords = '';
const int frozenQwen3SegmentDurationSeconds = 15;

void validateFrozenQwen3ProductProfile({
  required int numThreads,
  required int maxTotalLen,
  required int maxNewTokens,
  required double temperature,
  required double topP,
  required int seed,
  required String hotwords,
  required int segmentDurationSeconds,
}) {
  if (numThreads != 2 ||
      maxTotalLen != frozenQwen3MaxTotalLen ||
      maxNewTokens != frozenQwen3MaxNewTokens ||
      temperature != frozenQwen3Temperature ||
      topP != frozenQwen3TopP ||
      seed != frozenQwen3Seed ||
      hotwords != frozenQwen3Hotwords ||
      segmentDurationSeconds != frozenQwen3SegmentDurationSeconds) {
    throw const FormatException('Qwen3 product profile is not frozen');
  }
}

class SherpaDesktopModelSet {
  const SherpaDesktopModelSet({
    required this.convFrontendPath,
    required this.encoderPath,
    required this.decoderPath,
    required this.tokenizerPath,
    required this.segmentationPath,
    required this.embeddingPath,
  });

  final String convFrontendPath;
  final String encoderPath;
  final String decoderPath;
  final String tokenizerPath;
  final String segmentationPath;
  final String embeddingPath;

  bool get allFilesPresent =>
      <String>[
        convFrontendPath,
        encoderPath,
        decoderPath,
        segmentationPath,
        embeddingPath,
      ].every((path) => File(path).existsSync()) &&
      Directory(tokenizerPath).existsSync();
}

class SherpaDesktopProcessingEngine implements ProcessingEnginePort {
  SherpaDesktopProcessingEngine({
    required this.models,
    this.runtimeRoot,
    this.numThreads = 2,
    this.maxSegments = 200000,
  }) {
    if (!models.allFilesPresent) {
      throw StateError('Sherpa model set is incomplete.');
    }
    if (!SherpaRuntimeProbe.loadNativeRuntime(runtimeRoot)) {
      throw StateError('Sherpa native runtime is unavailable.');
    }
  }

  final SherpaDesktopModelSet models;
  final String? runtimeRoot;
  final int numThreads;
  final int maxSegments;

  @override
  String get engineId => 'sherpa-onnx-1.13.4/qwen3-asr-0.6b-int8-pyannote3';

  @override
  Future<ProcessingResult> process(
    ProcessingRequest request, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    final started = Stopwatch()..start();
    var peakResidentBytes = ProcessInfo.currentRss;
    void report(ProcessingProgress progress) {
      peakResidentBytes = max(peakResidentBytes, ProcessInfo.currentRss);
      onProgress(progress);
    }

    cancellationToken.throwIfCancelled();
    final wave = sherpa.readWave(request.sourcePath);
    if (wave.samples.isEmpty || wave.sampleRate != 16000) {
      throw StateError('Sherpa requires decoded mono 16 kHz PCM input.');
    }
    final duration = wave.samples.length / wave.sampleRate;
    if (duration > ProcessingOperationalEnvelope.desktopV1.maxDurationSeconds) {
      throw StateError('Source exceeds the desktop processing envelope.');
    }
    if (wave.samples.length * Float32List.bytesPerElement >
        ProcessingOperationalEnvelope.desktopV1.maxDecodedPcmBytes) {
      throw StateError('Decoded PCM exceeds the desktop processing envelope.');
    }
    final recognition = _recognize(
      wave,
      cancellationToken: cancellationToken,
      onProgress: report,
    );
    cancellationToken.throwIfCancelled();
    final rawSpeakers = _diarize(
      wave,
      cancellationToken: cancellationToken,
      onProgress: report,
    );
    final speakers = _suppressDetectedSilence(rawSpeakers, wave);
    cancellationToken.throwIfCancelled();
    final segments = _merge(recognition, speakers, duration: duration);
    if (segments.length > maxSegments) {
      throw StateError('Processing output exceeds the segment envelope.');
    }
    report(const ProcessingProgress(phase: 'complete', fraction: 1));
    started.stop();
    return ProcessingResult(
      segments: segments,
      engineId: engineId,
      elapsedMilliseconds: started.elapsedMilliseconds,
      peakResidentBytes: peakResidentBytes,
    );
  }

  _Qwen3Recognition _recognize(
    sherpa.WaveData wave, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) {
    final recognizer = sherpa.OfflineRecognizer(
      sherpa.OfflineRecognizerConfig(
        model: sherpa.OfflineModelConfig(
          qwen3Asr: sherpa.OfflineQwen3AsrModelConfig(
            convFrontend: models.convFrontendPath,
            encoder: models.encoderPath,
            decoder: models.decoderPath,
            tokenizer: models.tokenizerPath,
            maxTotalLen: frozenQwen3MaxTotalLen,
            maxNewTokens: frozenQwen3MaxNewTokens,
            temperature: frozenQwen3Temperature,
            topP: frozenQwen3TopP,
            seed: frozenQwen3Seed,
            hotwords: frozenQwen3Hotwords,
          ),
          tokens: '',
          numThreads: numThreads,
          debug: false,
          provider: 'cpu',
        ),
      ),
    );
    final texts = <String>[];
    final timestamps = <double>[];
    final segmentSamples = wave.sampleRate * frozenQwen3SegmentDurationSeconds;
    try {
      for (
        var offset = 0;
        offset < wave.samples.length;
        offset += segmentSamples
      ) {
        cancellationToken.throwIfCancelled();
        final end = min(offset + segmentSamples, wave.samples.length);
        final stream = recognizer.createStream();
        try {
          stream.acceptWaveform(
            samples: Float32List.sublistView(wave.samples, offset, end),
            sampleRate: wave.sampleRate,
          );
          cancellationToken.throwIfCancelled();
          recognizer.decode(stream);
          final text = readQwen3Result(stream).text.trim();
          if (text.isNotEmpty) {
            texts.add(text);
            timestamps.add(offset / wave.sampleRate);
          }
        } finally {
          stream.free();
        }
        onProgress(
          ProcessingProgress(
            phase: 'asr',
            fraction: 0.45 * end / wave.samples.length,
          ),
        );
      }
      if (texts.isEmpty) {
        throw StateError('Sherpa returned an empty transcript.');
      }
      return _Qwen3Recognition(
        text: texts.join(' '),
        segments: texts,
        timestamps: timestamps,
      );
    } finally {
      recognizer.free();
    }
  }

  List<sherpa.OfflineSpeakerDiarizationSegment> _diarize(
    sherpa.WaveData wave, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) {
    final diarizer = sherpa.OfflineSpeakerDiarization(
      sherpa.OfflineSpeakerDiarizationConfig(
        segmentation: sherpa.OfflineSpeakerSegmentationModelConfig(
          pyannote: sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(
            model: models.segmentationPath,
          ),
          numThreads: numThreads,
          debug: false,
        ),
        embedding: sherpa.SpeakerEmbeddingExtractorConfig(
          model: models.embeddingPath,
          numThreads: numThreads,
          debug: false,
        ),
        clustering: const sherpa.FastClusteringConfig(
          numClusters: -1,
          threshold: 0.5,
        ),
      ),
    );
    try {
      return diarizer.processWithCallback(
        samples: wave.samples,
        callback: (processed, total) {
          onProgress(
            ProcessingProgress(
              phase: 'diarization',
              fraction: 0.45 + 0.5 * processed / max(1, total),
            ),
          );
          // Sherpa 1.13.4 ignores the callback return value. The production
          // supervisor must terminate the isolated worker to interrupt this
          // native call; this direct adapter still checks cancellation before
          // publishing its result.
          return 1;
        },
      );
    } finally {
      diarizer.free();
    }
  }

  List<ProcessingTranscriptSegment> _merge(
    _Qwen3Recognition recognition,
    List<sherpa.OfflineSpeakerDiarizationSegment> speakers, {
    required double duration,
  }) {
    if (recognition.text.trim().isEmpty) {
      throw StateError('Sherpa returned an empty transcript.');
    }
    if (recognition.segments.isEmpty ||
        recognition.timestamps.length != recognition.segments.length) {
      return <ProcessingTranscriptSegment>[
        ProcessingTranscriptSegment(
          startSeconds: 0,
          endSeconds: duration,
          text: recognition.text,
          speakerAssignment: SpeakerAssignment.unknown,
        ),
      ];
    }
    final output = <ProcessingTranscriptSegment>[];
    for (var index = 0; index < recognition.segments.length; index += 1) {
      final start = recognition.timestamps[index].clamp(0.0, duration);
      final next = index + 1 < recognition.timestamps.length
          ? recognition.timestamps[index + 1]
          : duration;
      final end = max(start + 0.001, min(duration, next));
      final activeTurns = speakers
          .where((speaker) => speaker.start < end && speaker.end > start)
          .toList(growable: false);
      final active = activeTurns.map((speaker) => speaker.speaker).toSet();
      final hasConcurrentSpeakers = _hasConcurrentSpeakerTurns(
        activeTurns,
        start: start,
        end: end,
      );
      output.add(
        ProcessingTranscriptSegment(
          startSeconds: start,
          endSeconds: end,
          text: recognition.segments[index],
          speakerAssignment: hasConcurrentSpeakers
              ? SpeakerAssignment.overlap
              : active.length != 1
              ? SpeakerAssignment.unknown
              : SpeakerAssignment.anonymous,
          anonymousSpeakerKey: active.length == 1
              ? 'speaker_${(active.single + 1).toString().padLeft(2, '0')}'
              : null,
        ),
      );
    }
    return output;
  }

  bool _hasConcurrentSpeakerTurns(
    List<sherpa.OfflineSpeakerDiarizationSegment> turns, {
    required double start,
    required double end,
  }) {
    for (var leftIndex = 0; leftIndex < turns.length; leftIndex += 1) {
      final left = turns[leftIndex];
      for (
        var rightIndex = leftIndex + 1;
        rightIndex < turns.length;
        rightIndex += 1
      ) {
        final right = turns[rightIndex];
        if (left.speaker == right.speaker) continue;
        final overlapStart = max(start, max(left.start, right.start));
        final overlapEnd = min(end, min(left.end, right.end));
        if (overlapEnd > overlapStart) return true;
      }
    }
    return false;
  }

  List<sherpa.OfflineSpeakerDiarizationSegment> _suppressDetectedSilence(
    List<sherpa.OfflineSpeakerDiarizationSegment> segments,
    sherpa.WaveData wave,
  ) {
    final window = max(1, wave.sampleRate ~/ 50);
    final minimumSamples = (wave.sampleRate * 0.2).round();
    final silence = <({double start, double end})>[];
    int? silentStart;
    for (var offset = 0; offset < wave.samples.length; offset += window) {
      final end = min(offset + window, wave.samples.length);
      var maximum = 0.0;
      for (var index = offset; index < end; index += 1) {
        maximum = max(maximum, wave.samples[index].abs());
      }
      if (maximum <= 0.0005) {
        silentStart ??= offset;
      } else if (silentStart != null) {
        if (offset - silentStart >= minimumSamples) {
          silence.add((
            start: silentStart / wave.sampleRate,
            end: offset / wave.sampleRate,
          ));
        }
        silentStart = null;
      }
    }
    if (silentStart != null &&
        wave.samples.length - silentStart >= minimumSamples) {
      silence.add((
        start: silentStart / wave.sampleRate,
        end: wave.samples.length / wave.sampleRate,
      ));
    }
    final output = <sherpa.OfflineSpeakerDiarizationSegment>[];
    for (final segment in segments) {
      var pieces = <({double start, double end})>[
        (start: segment.start, end: segment.end),
      ];
      for (final exclusion in silence) {
        final next = <({double start, double end})>[];
        for (final piece in pieces) {
          if (exclusion.end <= piece.start || exclusion.start >= piece.end) {
            next.add(piece);
          } else {
            if (exclusion.start > piece.start) {
              next.add((start: piece.start, end: exclusion.start));
            }
            if (exclusion.end < piece.end) {
              next.add((start: exclusion.end, end: piece.end));
            }
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
    return output;
  }
}

class _Qwen3Recognition {
  const _Qwen3Recognition({
    required this.text,
    required this.segments,
    required this.timestamps,
  });

  final String text;
  final List<String> segments;
  final List<double> timestamps;
}
