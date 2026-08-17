import 'package:flutter/services.dart';

class AudioApiSecretStore {
  const AudioApiSecretStore({
    MethodChannel channel = const MethodChannel('voice2text/recorder'),
  }) : _channel = channel;

  final MethodChannel _channel;

  Future<void> save({
    required String providerId,
    required String secret,
  }) async {
    final normalized = secret.trim();
    if (normalized.isEmpty || normalized.length > 4096) {
      throw ArgumentError.value(secret, 'secret', '密钥长度无效');
    }
    await _channel.invokeMethod<void>('setAudioApiSecret', <String, Object?>{
      'providerId': providerId,
      'secret': normalized,
    });
  }

  Future<String?> read(String providerId) {
    return _channel.invokeMethod<String?>(
      'getAudioApiSecret',
      <String, Object?>{'providerId': providerId},
    );
  }

  Future<bool> hasSecret(String providerId) async {
    return await _channel.invokeMethod<bool>(
          'hasAudioApiSecret',
          <String, Object?>{'providerId': providerId},
        ) ??
        false;
  }

  Future<void> delete(String providerId) {
    return _channel.invokeMethod<void>(
      'deleteAudioApiSecret',
      <String, Object?>{'providerId': providerId},
    );
  }
}
