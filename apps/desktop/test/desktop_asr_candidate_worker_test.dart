import 'package:flutter_test/flutter_test.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import '../tool/asr_benchmark/candidate_registry.dart';
import '../tool/asr_benchmark/effective_profile.dart';

void main() {
  group('sherpa_onnx 1.13.4 API characterization', () {
    test('constructs streaming Zipformer configuration', () {
      final request = requestFor(
        family: 'streaming_zipformer_transducer',
        modelFiles: <String, Object?>{
          'encoder': modelFile('/models/encoder.onnx'),
          'decoder': modelFile('/models/decoder.onnx'),
          'joiner': modelFile('/models/joiner.onnx'),
          'tokens': modelFile('/models/tokens.txt'),
        },
        config: <String, Object?>{
          'modelFamily': 'streaming_transducer',
          'provider': 'cpu',
          'numThreads': 2,
          'modelPrecision': 'int8',
          'decodingMethod': 'greedy_search',
          'chunkSeconds': 0.32,
          'pacingPolicy': 'realtime_audio_clock',
          'endpointPolicy': 'official_default',
        },
      );
      final built = EffectiveProfile.fromRequest(request).build();

      expect(built, isA<OnlineSherpaProfile>());
      final config = (built as OnlineSherpaProfile).config;
      expect(config.model.transducer.encoder, '/models/encoder.onnx');
      expect(config.model.numThreads, 2);
      expect(config.model.provider, 'cpu');
      expect(config.decodingMethod, 'greedy_search');
    });

    test('constructs offline Paraformer configuration', () {
      final request = requestFor(
        family: 'offline_paraformer',
        modelFiles: <String, Object?>{
          'model': modelFile('/models/model.int8.onnx'),
          'tokens': modelFile('/models/tokens.txt'),
        },
        config: fixedConfig('offline_paraformer'),
      );
      final built = EffectiveProfile.fromRequest(request).build();

      expect(built, isA<OfflineSherpaProfile>());
      final config = (built as OfflineSherpaProfile).config;
      expect(config.model.paraformer.model, '/models/model.int8.onnx');
      expect(config.model.numThreads, 2);
      expect(config.decodingMethod, 'greedy_search');
    });

    test('constructs FunASR Nano generative controls', () {
      final request = requestFor(
        family: 'funasr_nano',
        modelFiles: <String, Object?>{
          'encoderAdaptor': modelFile('/models/encoder_adaptor.int8.onnx'),
          'llm': modelFile('/models/llm.int8.onnx'),
          'embedding': modelFile('/models/embedding.int8.onnx'),
          'tokenizer': modelFile('/models/tokenizer.json'),
        },
        config: <String, Object?>{
          'modelFamily': 'funasr_nano',
          'provider': 'cpu',
          'numThreads': 2,
          'modelPrecision': 'int8',
          'language': 'zh',
          'itn': true,
          'hotwords': '',
          'systemPrompt': 'You are a helpful assistant.',
          'userPrompt': '语音转写：',
          'seed': 20260726,
          'maxNewTokens': 512,
          'temperature': 0.0,
          'topP': 0.8,
        },
      );
      final built = EffectiveProfile.fromRequest(request).build();
      final model = (built as OfflineSherpaProfile).config.model.funasrNano;

      expect(model.seed, 20260726);
      expect(model.language, 'zh');
      expect(model.itn, 1);
      expect(model.temperature, 0.0);
      expect(model.hotwords, '');
    });

    test('constructs FireRedASR2 CTC configuration', () {
      final request = requestFor(
        family: 'firered_asr_ctc',
        modelFiles: <String, Object?>{
          'model': modelFile('/models/model.int8.onnx'),
          'tokens': modelFile('/models/tokens.txt'),
        },
        config: fixedConfig('firered_asr_ctc'),
      );
      final built = EffectiveProfile.fromRequest(request).build();

      expect(
        (built as OfflineSherpaProfile).config.model.fireRedAsrCtc.model,
        '/models/model.int8.onnx',
      );
    });

    test('installed package exposes every first-round family adapter', () {
      expect(
        BenchmarkCandidateFamily.values.map((value) => value.manifestValue),
        containsAll(<String>[
          'streaming_zipformer_transducer',
          'offline_paraformer',
          'funasr_nano',
          'firered_asr_ctc',
        ]),
      );
      expect(const sherpa.OfflineParaformerModelConfig(), isNotNull);
      expect(const sherpa.OfflineFunAsrNanoModelConfig(), isNotNull);
      expect(const sherpa.OfflineFireRedAsrCtcModelConfig(), isNotNull);
    });
  });

  test('unknown family fails before inference', () {
    final request = requestFor(
      family: 'unknown',
      modelFiles: <String, Object?>{},
      config: <String, Object?>{},
    );
    expect(
      () => CandidateWorkerRequest.fromJson(request),
      throwsA(isA<FormatException>()),
    );
  });

  test('extra model role fails instead of being ignored', () {
    final request = requestFor(
      family: 'offline_paraformer',
      modelFiles: <String, Object?>{
        'model': modelFile('/models/model.onnx'),
        'tokens': modelFile('/models/tokens.txt'),
        'mystery': modelFile('/models/mystery.bin'),
      },
      config: fixedConfig('offline_paraformer'),
    );
    expect(
      () => CandidateWorkerRequest.fromJson(request),
      throwsA(isA<FormatException>()),
    );
  });

  test('unknown effective config key fails instead of being ignored', () {
    final config = fixedConfig('offline_paraformer')
      ..['inventedControl'] = true;
    final request = requestFor(
      family: 'offline_paraformer',
      modelFiles: <String, Object?>{
        'model': modelFile('/models/model.onnx'),
        'tokens': modelFile('/models/tokens.txt'),
      },
      config: config,
    );
    expect(
      () => EffectiveProfile.fromRequest(request),
      throwsA(isA<FormatException>()),
    );
  });

  test('fixed-resource invariants cannot drift', () {
    final config = fixedConfig('offline_paraformer')..['numThreads'] = 4;
    final request = requestFor(
      family: 'offline_paraformer',
      modelFiles: <String, Object?>{
        'model': modelFile('/models/model.onnx'),
        'tokens': modelFile('/models/tokens.txt'),
      },
      config: config,
    );
    expect(
      () => EffectiveProfile.fromRequest(request),
      throwsA(isA<FormatException>()),
    );
  });

  test('fixed-resource segment duration cannot drift by candidate', () {
    final config = fixedConfig('offline_paraformer')
      ..['segmentDurationSeconds'] = 30;
    final request = requestFor(
      family: 'offline_paraformer',
      modelFiles: <String, Object?>{
        'model': modelFile('/models/model.onnx'),
        'tokens': modelFile('/models/tokens.txt'),
      },
      config: config,
    );
    expect(
      () => EffectiveProfile.fromRequest(request),
      throwsA(isA<FormatException>()),
    );
  });

  test('baseline acknowledgement is identity-bound', () {
    final request = CandidateWorkerRequest.fromJson(
      requestFor(
        family: 'offline_paraformer',
        modelFiles: <String, Object?>{
          'model': modelFile('/models/model.onnx'),
          'tokens': modelFile('/models/tokens.txt'),
        },
        config: fixedConfig('offline_paraformer'),
      ),
    );
    final acknowledgement = <String, Object?>{
      'schemaVersion': 2,
      'type': 'baselineFrozen',
      'candidateId': request.candidateId,
      'profileId': request.profileId,
      'sourceSha256': request.sourceSha256,
    };
    expect(
      () => BaselineFreezeAck.validate(acknowledgement, request),
      returnsNormally,
    );
    expect(
      () => BaselineFreezeAck.validate(<String, Object?>{
        ...acknowledgement,
        'sourceSha256': List<String>.filled(64, 'f').join(),
      }, request),
      throwsA(isA<FormatException>()),
    );
  });
}

Map<String, Object?> requestFor({
  required String family,
  required Map<String, Object?> modelFiles,
  required Map<String, Object?> config,
}) => <String, Object?>{
  'schemaVersion': 2,
  'candidateId': 'candidate-with-unambiguous-id',
  'family': family,
  'profileId': config.containsKey('concurrency')
      ? 'fixed-resource'
      : 'recommended',
  'sourcePath': '/fixtures/input.wav',
  'sourceSha256': List<String>.filled(64, 'a').join(),
  'modelFiles': modelFiles,
  'effectiveConfig': config,
  'capabilities': <String, Object?>{
    'streaming': family == 'streaming_zipformer_transducer',
    'timestamps': true,
    'partialResults': family == 'streaming_zipformer_transducer',
    'endpointing': family == 'streaming_zipformer_transducer',
    'hotwords': family == 'funasr_nano',
    'punctuation': family == 'funasr_nano',
    'itn': family == 'funasr_nano',
    'seededGeneration': family == 'funasr_nano',
  },
  'expectSpeech': true,
  'settleMilliseconds': 10,
};

Map<String, Object?> modelFile(String path) => <String, Object?>{
  'path': path,
  'sha256': List<String>.filled(64, 'b').join(),
};

Map<String, Object?> fixedConfig(String family) => <String, Object?>{
  'modelFamily': family,
  'provider': 'cpu',
  'numThreads': 2,
  'concurrency': 1,
  'inputMode': 'frozen_segments',
  'segmentDurationSeconds': 15,
  'pacingPolicy': 'unpaced',
  'warmupRuns': 1,
  'measuredRuns': 5,
  'modelPrecision': 'int8',
  'decodingMethod': 'greedy_search',
};
