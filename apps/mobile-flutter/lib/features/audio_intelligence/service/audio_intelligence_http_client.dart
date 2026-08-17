import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'audio_intelligence_provider.dart';

class AudioIntelligenceHttpRequest {
  const AudioIntelligenceHttpRequest({
    required this.uri,
    required this.headers,
    required this.body,
  });

  final Uri uri;
  final Map<String, String> headers;
  final String body;
}

class AudioIntelligenceHttpResponse {
  const AudioIntelligenceHttpResponse({
    required this.statusCode,
    required this.body,
  });

  final int statusCode;
  final String body;
}

abstract interface class AudioIntelligenceHttpTransport {
  Future<AudioIntelligenceHttpResponse> send(
    AudioIntelligenceHttpRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  });
}

class AudioIntelligenceHttpClient implements AudioIntelligenceHttpTransport {
  AudioIntelligenceHttpClient({
    this.allowedHost = 'api.deepseek.com',
    this.connectTimeout = const Duration(seconds: 10),
    this.readTimeout = const Duration(seconds: 45),
    this.maximumResponseBytes = 512 * 1024,
    HttpClient Function()? clientFactory,
  }) : _clientFactory = clientFactory ?? HttpClient.new;

  final String allowedHost;
  final Duration connectTimeout;
  final Duration readTimeout;
  final int maximumResponseBytes;
  final HttpClient Function() _clientFactory;

  @override
  Future<AudioIntelligenceHttpResponse> send(
    AudioIntelligenceHttpRequest request, {
    AudioIntelligenceCancellationToken? cancellationToken,
  }) async {
    _validateUri(request.uri);
    cancellationToken?.throwIfCanceled();
    final client = _clientFactory()
      ..connectionTimeout = connectTimeout
      ..idleTimeout = readTimeout
      ..autoUncompress = true;
    HttpClientRequest? nativeRequest;
    void abort() => nativeRequest?.abort();
    final removeCancellationListener = cancellationToken?.addListener(abort);
    try {
      nativeRequest = await client.postUrl(request.uri).timeout(connectTimeout);
      nativeRequest.followRedirects = false;
      nativeRequest.maxRedirects = 0;
      request.headers.forEach(nativeRequest.headers.set);
      nativeRequest.add(utf8.encode(request.body));
      final response = await nativeRequest.close().timeout(readTimeout);
      if (response.isRedirect) {
        throw const AudioIntelligenceProviderException(
          AudioIntelligenceFailureCode.networkUnavailable,
          '云端服务返回了不受信任的重定向',
        );
      }
      final bytes = <int>[];
      await for (final chunk in response.timeout(readTimeout)) {
        cancellationToken?.throwIfCanceled();
        if (bytes.length + chunk.length > maximumResponseBytes) {
          nativeRequest.abort();
          throw const AudioIntelligenceProviderException(
            AudioIntelligenceFailureCode.responseTooLarge,
            '云端结果超过安全大小限制',
          );
        }
        bytes.addAll(chunk);
      }
      cancellationToken?.throwIfCanceled();
      return AudioIntelligenceHttpResponse(
        statusCode: response.statusCode,
        body: utf8.decode(bytes, allowMalformed: false),
      );
    } on AudioIntelligenceProviderException {
      rethrow;
    } on TimeoutException {
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.networkUnavailable,
        '云端请求超时，请稍后重试',
      );
    } on Object {
      if (cancellationToken?.isCanceled == true) {
        throw const AudioIntelligenceProviderException(
          AudioIntelligenceFailureCode.canceled,
          '生成已取消',
        );
      }
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.networkUnavailable,
        '无法连接云端服务，请检查网络后重试',
      );
    } finally {
      removeCancellationListener?.call();
      client.close(force: true);
    }
  }

  void _validateUri(Uri uri) {
    if (uri.scheme != 'https' ||
        uri.host != allowedHost ||
        (uri.hasPort && uri.port != 443) ||
        uri.userInfo.isNotEmpty) {
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.networkUnavailable,
        '云端服务地址不受信任',
      );
    }
  }
}
