import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:processing_contracts/processing_contracts.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'qwen3_result.dart';
import 'sherpa_runtime_probe.dart';

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
    final segments = _sileroSegments(wave);
    try {
      for (final segment in segments) {
        cancellationToken.throwIfCancelled();
        final end = segment.startSample + segment.samples.length;
        final stream = recognizer.createStream();
        try {
          stream.acceptWaveform(
            samples: segment.samples,
            sampleRate: wave.sampleRate,
          );
          cancellationToken.throwIfCancelled();
          recognizer.decode(stream);
          final text = readQwen3Result(stream).text.trim();
          if (text.isNotEmpty) {
            texts.add(text);
            timestamps.add(segment.startSample / wave.sampleRate);
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

  List<_AudioSegment> _sileroSegments(sherpa.WaveData wave) {
    final detector = sherpa.VoiceActivityDetector(
      config: sherpa.VadModelConfig(
        sileroVad: sherpa.SileroVadModelConfig(
          model: models.vadPath,
          threshold: frozenQwen3VadThreshold,
          minSilenceDuration: frozenQwen3MinimumSilenceSeconds,
          minSpeechDuration: frozenQwen3MinimumSpeechSeconds,
          maxSpeechDuration: frozenQwen3MaximumSpeechSeconds,
          windowSize: frozenQwen3VadWindowSize,
        ),
        sampleRate: wave.sampleRate,
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      ),
      bufferSizeInSeconds: ProcessingOperationalEnvelope
          .desktopV1
          .maxDurationSeconds
          .toDouble(),
    );
    final result = <_AudioSegment>[];
    void drain() {
      while (!detector.isEmpty()) {
        final segment = detector.front();
        detector.pop();
        if (segment.samples.isNotEmpty) {
          result.add(
            _AudioSegment(startSample: segment.start, samples: segment.samples),
          );
        }
      }
    }

    try {
      for (
        var start = 0;
        start < wave.samples.length;
        start += frozenQwen3VadWindowSize
      ) {
        detector.acceptWaveform(
          Float32List.sublistView(
            wave.samples,
            start,
            min(start + frozenQwen3VadWindowSize, wave.samples.length),
          ),
        );
        drain();
      }
      detector.flush();
      drain();
    } finally {
      detector.free();
    }
    return result;
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

class _AudioSegment {
  const _AudioSegment({required this.startSample, required this.samples});

  final int startSample;
  final Float32List samples;
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
