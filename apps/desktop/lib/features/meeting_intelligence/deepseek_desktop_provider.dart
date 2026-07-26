import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:meeting_workflows/meeting_workflows.dart';

import '../secrets/desktop_secret_store.dart';

class DesktopAiHttpResponse {
  const DesktopAiHttpResponse(this.statusCode, this.body);

  final int statusCode;
  final String body;
}

abstract interface class DesktopAiHttpTransport {
  Future<DesktopAiHttpResponse> post({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  });
}

class DesktopAiHttpsTransport implements DesktopAiHttpTransport {
  const DesktopAiHttpsTransport({
    this.allowedHost = 'api.deepseek.com',
    this.maximumResponseBytes = 512 * 1024,
  });

  final String allowedHost;
  final int maximumResponseBytes;

  @override
  Future<DesktopAiHttpResponse> post({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    if (uri.scheme != 'https' ||
        uri.host != allowedHost ||
        uri.userInfo.isNotEmpty ||
        uri.hasPort && uri.port != 443) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.networkUnavailable,
        '云端服务地址不受信任',
      );
    }
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10)
      ..idleTimeout = const Duration(seconds: 45);
    try {
      final request = await client
          .postUrl(uri)
          .timeout(const Duration(seconds: 10));
      request
        ..followRedirects = false
        ..maxRedirects = 0;
      headers.forEach(request.headers.set);
      request.add(utf8.encode(body));
      final response = await request.close().timeout(
        const Duration(seconds: 45),
      );
      if (response.isRedirect) {
        throw const MeetingAiFailure(
          MeetingAiFailureCode.networkUnavailable,
          '云端服务返回了不受信任的重定向',
        );
      }
      final bytes = <int>[];
      await for (final chunk in response.timeout(const Duration(seconds: 45))) {
        if (bytes.length + chunk.length > maximumResponseBytes) {
          throw const MeetingAiFailure(
            MeetingAiFailureCode.invalidOutput,
            '云端结果超过安全大小限制',
          );
        }
        bytes.addAll(chunk);
      }
      return DesktopAiHttpResponse(
        response.statusCode,
        utf8.decode(bytes, allowMalformed: false),
      );
    } on MeetingAiFailure {
      rethrow;
    } on TimeoutException {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.networkUnavailable,
        '云端请求超时，请稍后重试',
      );
    } on Object {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.networkUnavailable,
        '无法连接云端服务，请检查网络后重试',
      );
    } finally {
      client.close(force: true);
    }
  }
}

class DeepSeekDesktopMeetingAiProvider implements MeetingAiProviderPort {
  DeepSeekDesktopMeetingAiProvider({
    required DesktopSecretStore secretStore,
    DesktopAiHttpTransport transport = const DesktopAiHttpsTransport(),
    this.modelId = 'deepseek-chat',
    Uri? endpoint,
  }) : _secretStore = secretStore,
       _transport = transport,
       endpoint =
           endpoint ?? Uri.parse('https://api.deepseek.com/chat/completions');

  final DesktopSecretStore _secretStore;
  final DesktopAiHttpTransport _transport;
  final Uri endpoint;

  @override
  String get providerId => 'deepseek';

  @override
  final String modelId;

  @override
  Future<bool> isConfigured() => _secretStore.contains(providerId);

  @override
  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    final secret = await _secretStore.read(providerId);
    if (secret == null || secret.isEmpty) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.secretMissing,
        '请先在设置中输入云端密钥',
      );
    }
    final response = await _transport.post(
      uri: endpoint,
      headers: <String, String>{
        'content-type': 'application/json',
        'accept': 'application/json',
        'authorization': 'Bearer $secret',
      },
      body: jsonEncode(<String, Object?>{
        'model': modelId,
        'messages': <Object?>[
          <String, Object?>{
            'role': 'system',
            'content':
                '你是会议记录助手。只依据输入转写生成结构化 JSON；'
                '不得猜测身份或补充转写外事实。输出 schema_version、'
                'suggested_title、meeting_type、items。items 中每项包含 '
                'kind、body、evidence、action_owner、action_due_at_ms。'
                'evidence 只能引用输入的 segment_id/start_ms/end_ms。',
          },
          <String, Object?>{
            'role': 'user',
            'content': jsonEncode(<String, Object?>{
              'title': request.meetingTitle,
              'template_id': request.templateId,
              'segments': request.segments
                  .map(
                    (segment) => <String, Object?>{
                      'segment_id': segment.id,
                      'start_ms': segment.startMs,
                      'end_ms': segment.endMs,
                      'speaker_state': segment.speakerState.name,
                      'text': segment.text,
                    },
                  )
                  .toList(),
            }),
          },
        ],
        'response_format': <String, Object?>{'type': 'json_object'},
        'stream': false,
        'max_tokens': 2048,
        'thinking': <String, Object?>{'type': 'disabled'},
      }),
    );
    if (response.statusCode != HttpStatus.ok) {
      throw switch (response.statusCode) {
        401 => const MeetingAiFailure(
          MeetingAiFailureCode.unauthorized,
          '云端密钥无效，请重新输入',
        ),
        429 => const MeetingAiFailure(
          MeetingAiFailureCode.rateLimited,
          '云端请求过于频繁，请稍后重试',
        ),
        _ => const MeetingAiFailure(
          MeetingAiFailureCode.serviceUnavailable,
          '云端服务暂时不可用，请稍后重试',
        ),
      };
    }
    try {
      final envelope = jsonDecode(response.body) as Map<String, Object?>;
      final choices = envelope['choices'] as List<Object?>;
      final choice = (choices.single as Map).cast<String, Object?>();
      if (choice['finish_reason'] == 'length') {
        throw const FormatException('truncated');
      }
      final message = (choice['message'] as Map).cast<String, Object?>();
      return _decodeOutput(message['content']! as String);
    } on MeetingAiFailure {
      rethrow;
    } on Object {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidOutput,
        '云端结果结构无效，请重试',
      );
    }
  }

  MeetingAiOutput _decodeOutput(String source) {
    final root = (jsonDecode(source) as Map).cast<String, Object?>();
    if (root['schema_version'] != 'meeting_intelligence_output/v1' ||
        root['items'] is! List<Object?>) {
      throw const FormatException('invalid schema');
    }
    final items = (root['items']! as List<Object?>)
        .map((value) {
          final item = (value as Map).cast<String, Object?>();
          final evidence = (item['evidence'] as List<Object?>? ?? const [])
              .map((value) {
                final link = (value as Map).cast<String, Object?>();
                return MeetingAiEvidence(
                  segmentId: link['segment_id']! as int,
                  startMs: link['start_ms']! as int,
                  endMs: link['end_ms']! as int,
                );
              })
              .toList(growable: false);
          return MeetingAiInsight(
            kind: item['kind']! as String,
            body: item['body']! as String,
            evidence: evidence,
            actionOwner: item['action_owner'] as String?,
            actionDueAtMs: item['action_due_at_ms'] as int?,
          );
        })
        .toList(growable: false);
    return MeetingAiOutput(
      insights: items,
      suggestedTitle: root['suggested_title'] as String?,
      meetingType: root['meeting_type'] as String?,
    );
  }
}
