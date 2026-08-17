import 'dart:convert';

import '../model/audio_insight_entity.dart';
import 'audio_api_secret_store.dart';
import 'audio_intelligence_http_client.dart';
import 'audio_intelligence_output_codec.dart';
import 'audio_intelligence_provider.dart';
import 'audio_prompt_builder.dart';

typedef AudioSecretLoader = Future<String?> Function();

class DeepSeekAudioIntelligenceProvider implements AudioIntelligenceProvider {
  DeepSeekAudioIntelligenceProvider({
    required this.modelId,
    AudioIntelligenceHttpTransport? transport,
    AudioSecretLoader? secretLoader,
    AudioApiSecretStore secretStore = const AudioApiSecretStore(),
    this.outputCodec = const AudioIntelligenceOutputCodec(),
    this.promptBuilder = const AudioPromptBuilder(),
    this.maximumOutputTokens = 2048,
    Uri? endpoint,
  }) : transport = transport ?? AudioIntelligenceHttpClient(),
       secretLoader = secretLoader ?? (() => secretStore.read('deepseek')),
       endpoint =
           endpoint ?? Uri.parse('https://api.deepseek.com/chat/completions');

  @override
  final String modelId;
  final AudioIntelligenceHttpTransport transport;
  final AudioSecretLoader secretLoader;
  final AudioIntelligenceOutputCodec outputCodec;
  final AudioPromptBuilder promptBuilder;
  final int maximumOutputTokens;
  final Uri endpoint;

  @override
  String get providerId => 'deepseek';

  @override
  AudioIntelligenceCapabilities get capabilities =>
      AudioIntelligenceCapabilities(
        processingLocations: const <AudioProcessingLocation>{
          AudioProcessingLocation.cloudDirect,
        },
        supportedKinds: AudioInsightKind.values.toSet(),
      );

  @override
  Future<AudioIntelligenceOutput> generate(
    AudioIntelligenceRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    final secret = await secretLoader();
    if (secret == null || secret.trim().isEmpty) {
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.secretUnavailable,
        '请先重新输入云端密钥',
      );
    }
    final prompt = promptBuilder.build(request);
    final response = await transport.send(
      AudioIntelligenceHttpRequest(
        uri: endpoint,
        headers: <String, String>{
          'content-type': 'application/json',
          'accept': 'application/json',
          'authorization': 'Bearer ${secret.trim()}',
        },
        body: jsonEncode(<String, Object?>{
          'model': modelId,
          'messages': <Object?>[
            <String, Object?>{'role': 'system', 'content': prompt.system},
            <String, Object?>{'role': 'user', 'content': prompt.user},
          ],
          'response_format': <String, Object?>{'type': 'json_object'},
          'stream': false,
          'max_tokens': maximumOutputTokens,
          'thinking': <String, Object?>{'type': 'disabled'},
        }),
      ),
      cancellationToken: cancellationToken,
    );
    if (response.statusCode != 200) {
      throw _statusFailure(response.statusCode);
    }
    final root = _decodeEnvelope(response.body);
    final choices = root['choices'];
    if (choices is! List || choices.isEmpty || choices.first is! Map) {
      throw _invalidResponse();
    }
    final choice = (choices.first as Map).cast<Object?, Object?>();
    if (choice['finish_reason'] == 'length') {
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.responseInvalid,
        '云端结果被截断，请缩小发送范围后重试',
      );
    }
    final message = choice['message'];
    if (message is! Map) {
      throw _invalidResponse();
    }
    final content = message['content'];
    if (content is! String || content.trim().isEmpty) {
      throw _invalidResponse();
    }
    try {
      return outputCodec.decode(content);
    } on FormatException {
      throw _invalidResponse();
    }
  }

  Map<String, Object?> _decodeEnvelope(String body) {
    try {
      final value = jsonDecode(body);
      if (value is! Map || value.keys.any((key) => key is! String)) {
        throw const FormatException();
      }
      return value.cast<String, Object?>();
    } on FormatException {
      throw _invalidResponse();
    }
  }

  AudioIntelligenceProviderException _statusFailure(int statusCode) {
    return switch (statusCode) {
      401 => const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.unauthorized,
        '云端密钥无效，请重新输入',
      ),
      402 => const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.paymentRequired,
        '云端账户余额不足',
      ),
      429 => const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.rateLimited,
        '云端请求过于频繁，请稍后重试',
      ),
      500 || 503 => const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.serviceUnavailable,
        '云端服务暂时不可用，请稍后重试',
      ),
      _ => const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.serviceUnavailable,
        '云端服务返回错误，请稍后重试',
      ),
    };
  }

  AudioIntelligenceProviderException _invalidResponse() {
    return const AudioIntelligenceProviderException(
      AudioIntelligenceFailureCode.responseInvalid,
      '云端结果结构无效，请重试',
    );
  }
}
