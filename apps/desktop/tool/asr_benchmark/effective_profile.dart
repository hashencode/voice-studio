import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import 'candidate_registry.dart';

sealed class BuiltSherpaProfile {
  const BuiltSherpaProfile({
    required this.effectiveConfig,
    required this.capabilities,
  });

  final Map<String, Object?> effectiveConfig;
  final CandidateCapabilities capabilities;
}

class OnlineSherpaProfile extends BuiltSherpaProfile {
  const OnlineSherpaProfile({
    required this.config,
    required this.chunkSeconds,
    required super.effectiveConfig,
    required super.capabilities,
  });

  final sherpa.OnlineRecognizerConfig config;
  final double chunkSeconds;
}

class OfflineSherpaProfile extends BuiltSherpaProfile {
  const OfflineSherpaProfile({
    required this.config,
    required super.effectiveConfig,
    required super.capabilities,
  });

  final sherpa.OfflineRecognizerConfig config;
}

class EffectiveProfile {
  const EffectiveProfile._({required this.request, required this.config});

  factory EffectiveProfile.fromRequest(Map<String, Object?> json) {
    final request = CandidateWorkerRequest.fromJson(json);
    return EffectiveProfile.fromCandidateRequest(request);
  }

  factory EffectiveProfile.fromCandidateRequest(
    CandidateWorkerRequest request,
  ) {
    final config = request.effectiveConfig;
    final expected = <String>{
      'modelFamily',
      'provider',
      'numThreads',
      'modelPrecision',
      ...switch (request.family) {
        BenchmarkCandidateFamily.streamingTransducer => <String>{
          'decodingMethod',
          if (request.profileId == 'recommended') ...<String>{
            'chunkSeconds',
            'pacingPolicy',
            'endpointPolicy',
          },
        },
        BenchmarkCandidateFamily.offlineParaformer => <String>{
          'decodingMethod',
          if (request.profileId == 'recommended') ...<String>{
            'hotwords',
            'hotwordScore',
          },
        },
        BenchmarkCandidateFamily.funasrNano => <String>{
          'language',
          'itn',
          'hotwords',
          'systemPrompt',
          'userPrompt',
          'seed',
          'maxNewTokens',
          'temperature',
          'topP',
        },
        BenchmarkCandidateFamily.fireRedAsrCtc => <String>{'decodingMethod'},
      },
      if (request.profileId == 'fixed-resource') ...<String>{
        'concurrency',
        'inputMode',
        'segmentDurationSeconds',
        'pacingPolicy',
        'warmupRuns',
        'measuredRuns',
      },
    };
    if (config.keys.toSet().difference(expected).isNotEmpty ||
        expected.difference(config.keys.toSet()).isNotEmpty) {
      throw const FormatException('effective config fields mismatch');
    }
    if (config['modelFamily'] != request.family.profileValue ||
        config['provider'] != 'cpu' ||
        config['numThreads'] is! int ||
        (config['numThreads']! as int) <= 0 ||
        (config['numThreads']! as int) > 8 ||
        config['modelPrecision'] is! String) {
      throw const FormatException('effective config common fields are invalid');
    }
    if (request.profileId == 'fixed-resource' &&
        (config['numThreads'] != 2 ||
            config['concurrency'] != 1 ||
            config['inputMode'] != 'frozen_segments' ||
            config['segmentDurationSeconds'] != 15 ||
            config['pacingPolicy'] != 'unpaced' ||
            config['warmupRuns'] != 1 ||
            config['measuredRuns'] != 5)) {
      throw const FormatException('fixed-resource invariants are invalid');
    }
    _validateFamilyConfig(request.family, config);
    return EffectiveProfile._(
      request: request,
      config: Map<String, Object?>.unmodifiable(config),
    );
  }

  final CandidateWorkerRequest request;
  final Map<String, Object?> config;

  BuiltSherpaProfile build() {
    final threads = config['numThreads']! as int;
    final provider = config['provider']! as String;
    return switch (request.family) {
      BenchmarkCandidateFamily.streamingTransducer => OnlineSherpaProfile(
        config: sherpa.OnlineRecognizerConfig(
          model: sherpa.OnlineModelConfig(
            transducer: sherpa.OnlineTransducerModelConfig(
              encoder: _file('encoder'),
              decoder: _file('decoder'),
              joiner: _file('joiner'),
            ),
            tokens: _file('tokens'),
            numThreads: threads,
            provider: provider,
            debug: false,
            modelType: 'zipformer',
            modelingUnit: 'char',
          ),
          decodingMethod: config['decodingMethod']! as String,
          enableEndpoint:
              request.profileId == 'recommended' &&
              config['endpointPolicy'] != 'disabled',
        ),
        chunkSeconds: request.profileId == 'recommended'
            ? (config['chunkSeconds']! as num).toDouble()
            : 0,
        effectiveConfig: config,
        capabilities: request.capabilities,
      ),
      BenchmarkCandidateFamily.offlineParaformer => OfflineSherpaProfile(
        config: sherpa.OfflineRecognizerConfig(
          model: sherpa.OfflineModelConfig(
            paraformer: sherpa.OfflineParaformerModelConfig(
              model: _file('model'),
            ),
            tokens: _file('tokens'),
            numThreads: threads,
            provider: provider,
            debug: false,
          ),
          decodingMethod: config['decodingMethod']! as String,
          hotwordsFile: request.profileId == 'recommended'
              ? config['hotwords']! as String
              : '',
          hotwordsScore: request.profileId == 'recommended'
              ? (config['hotwordScore']! as num).toDouble()
              : 1.5,
        ),
        effectiveConfig: config,
        capabilities: request.capabilities,
      ),
      BenchmarkCandidateFamily.funasrNano => OfflineSherpaProfile(
        config: sherpa.OfflineRecognizerConfig(
          model: sherpa.OfflineModelConfig(
            funasrNano: sherpa.OfflineFunAsrNanoModelConfig(
              encoderAdaptor: _file('encoderAdaptor'),
              llm: _file('llm'),
              embedding: _file('embedding'),
              tokenizer: _file('tokenizer'),
              systemPrompt: config['systemPrompt']! as String,
              userPrompt: config['userPrompt']! as String,
              maxNewTokens: config['maxNewTokens']! as int,
              temperature: (config['temperature']! as num).toDouble(),
              topP: (config['topP']! as num).toDouble(),
              seed: config['seed']! as int,
              language: config['language']! as String,
              itn: config['itn']! as bool ? 1 : 0,
              hotwords: config['hotwords']! as String,
            ),
            tokens: '',
            numThreads: threads,
            provider: provider,
            debug: false,
          ),
        ),
        effectiveConfig: config,
        capabilities: request.capabilities,
      ),
      BenchmarkCandidateFamily.fireRedAsrCtc => OfflineSherpaProfile(
        config: sherpa.OfflineRecognizerConfig(
          model: sherpa.OfflineModelConfig(
            fireRedAsrCtc: sherpa.OfflineFireRedAsrCtcModelConfig(
              model: _file('model'),
            ),
            tokens: _file('tokens'),
            numThreads: threads,
            provider: provider,
            debug: false,
          ),
          decodingMethod: config['decodingMethod']! as String,
        ),
        effectiveConfig: config,
        capabilities: request.capabilities,
      ),
    };
  }

  String _file(String role) => request.modelFiles[role]!.path;
}

void _validateFamilyConfig(
  BenchmarkCandidateFamily family,
  Map<String, Object?> config,
) {
  if (config.containsKey('decodingMethod')) {
    final method = config['decodingMethod'];
    if (method is! String || method != 'greedy_search') {
      throw const FormatException('decodingMethod is unsupported');
    }
  }
  switch (family) {
    case BenchmarkCandidateFamily.streamingTransducer:
      if (config.containsKey('chunkSeconds')) {
        final chunk = config['chunkSeconds'];
        if (chunk is! num ||
            !chunk.toDouble().isFinite ||
            chunk.toDouble() <= 0 ||
            chunk.toDouble() > 2) {
          throw const FormatException('chunkSeconds is invalid');
        }
      }
      if (config.containsKey('pacingPolicy')) {
        final pacing = config['pacingPolicy'];
        if (!const <String>{
          'realtime_audio_clock',
          'unpaced',
        }.contains(pacing)) {
          throw const FormatException('pacingPolicy is unsupported');
        }
      }
    case BenchmarkCandidateFamily.offlineParaformer:
      if (config.containsKey('hotwords')) {
        final hotwords = config['hotwords'];
        if (hotwords is! String) {
          throw const FormatException(
            'hotwords must resolve to a path or empty',
          );
        }
      }
      if (config.containsKey('hotwordScore')) {
        final score = config['hotwordScore'];
        if (score is! num || !score.toDouble().isFinite) {
          throw const FormatException('hotwordScore is invalid');
        }
      }
    case BenchmarkCandidateFamily.funasrNano:
      if (config['language'] is! String ||
          config['itn'] is! bool ||
          config['hotwords'] is! String ||
          config['systemPrompt'] is! String ||
          config['userPrompt'] is! String ||
          config['seed'] is! int ||
          config['maxNewTokens'] is! int ||
          config['temperature'] is! num ||
          config['topP'] is! num) {
        throw const FormatException('FunASR Nano controls are invalid');
      }
      final temperature = (config['temperature']! as num).toDouble();
      final topP = (config['topP']! as num).toDouble();
      if (!temperature.isFinite ||
          temperature < 0 ||
          !topP.isFinite ||
          topP <= 0 ||
          topP > 1 ||
          (config['maxNewTokens']! as int) <= 0 ||
          (config['maxNewTokens']! as int) > 4096) {
        throw const FormatException(
          'FunASR Nano generation bounds are invalid',
        );
      }
    case BenchmarkCandidateFamily.fireRedAsrCtc:
      break;
  }
}
