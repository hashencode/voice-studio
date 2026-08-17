import 'dart:convert';

import '../model/meeting_insight_entity.dart';
import 'meeting_api_secret_store.dart';
import 'meeting_intelligence_http_client.dart';
import 'meeting_intelligence_output_codec.dart';
import 'meeting_intelligence_provider.dart';
import 'meeting_prompt_builder.dart';

typedef MeetingSecretLoader = Future<String?> Function();

class DeepSeekMeetingIntelligenceProvider
    implements MeetingIntelligenceProvider {
  DeepSeekMeetingIntelligenceProvider({
    required this.modelId,
    MeetingIntelligenceHttpTransport? transport,
    MeetingSecretLoader? secretLoader,
    MeetingApiSecretStore secretStore = const MeetingApiSecretStore(),
    this.outputCodec = const MeetingIntelligenceOutputCodec(),
    this.promptBuilder = const MeetingPromptBuilder(),
    this.maximumOutputTokens = 2048,
    Uri? endpoint,
  }) : transport = transport ?? MeetingIntelligenceHttpClient(),
       secretLoader = secretLoader ?? (() => secretStore.read('deepseek')),
       endpoint =
           endpoint ?? Uri.parse('https://api.deepseek.com/chat/completions');

  @override
  final String modelId;
  final MeetingIntelligenceHttpTransport transport;
  final MeetingSecretLoader secretLoader;
  final MeetingIntelligenceOutputCodec outputCodec;
  final MeetingPromptBuilder promptBuilder;
  final int maximumOutputTokens;
  final Uri endpoint;

  @override
  String get providerId => 'deepseek';

  @override
  MeetingIntelligenceCapabilities get capabilities =>
      MeetingIntelligenceCapabilities(
        processingLocations: const <MeetingProcessingLocation>{
          MeetingProcessingLocation.cloudDirect,
        },
        supportedKinds: MeetingInsightKind.values.toSet(),
      );

  @override
  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request, {
    MeetingIntelligenceCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    final secret = await secretLoader();
    if (secret == null || secret.trim().isEmpty) {
      throw const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.secretUnavailable,
        '请先重新输入云端密钥',
      );
    }
    final prompt = promptBuilder.build(request);
    final response = await transport.send(
      MeetingIntelligenceHttpRequest(
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
      throw const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.responseInvalid,
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

  MeetingIntelligenceProviderException _statusFailure(int statusCode) {
    return switch (statusCode) {
      401 => const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.unauthorized,
        '云端密钥无效，请重新输入',
      ),
      402 => const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.paymentRequired,
        '云端账户余额不足',
      ),
      429 => const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.rateLimited,
        '云端请求过于频繁，请稍后重试',
      ),
      500 || 503 => const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.serviceUnavailable,
        '云端服务暂时不可用，请稍后重试',
      ),
      _ => const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.serviceUnavailable,
        '云端服务返回错误，请稍后重试',
      ),
    };
  }

  MeetingIntelligenceProviderException _invalidResponse() {
    return const MeetingIntelligenceProviderException(
      MeetingIntelligenceFailureCode.responseInvalid,
      '云端结果结构无效，请重试',
    );
  }
}
