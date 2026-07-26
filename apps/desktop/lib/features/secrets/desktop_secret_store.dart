import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class DesktopSecretStore {
  Future<String?> read(String providerId);

  Future<bool> contains(String providerId);

  Future<void> replace(String providerId, String secret);

  Future<void> delete(String providerId);
}

class KeychainDesktopSecretStore implements DesktopSecretStore {
  const KeychainDesktopSecretStore({
    FlutterSecureStorage storage = const FlutterSecureStorage(
      mOptions: MacOsOptions(
        accountName: 'com.voice2text.desktop.meeting-ai',
        accessibility: KeychainAccessibility.unlocked_this_device,
        synchronizable: false,
        usesDataProtectionKeychain: true,
      ),
    ),
  }) : _storage = storage;

  final FlutterSecureStorage _storage;

  static String _key(String providerId) {
    if (!RegExp(r'^[a-z0-9][a-z0-9._-]{1,63}$').hasMatch(providerId)) {
      throw ArgumentError.value(providerId, 'providerId');
    }
    return 'provider.$providerId.api-key';
  }

  @override
  Future<String?> read(String providerId) =>
      _storage.read(key: _key(providerId));

  @override
  Future<bool> contains(String providerId) async {
    final value = await read(providerId);
    return value?.isNotEmpty == true;
  }

  @override
  Future<void> replace(String providerId, String secret) async {
    final normalized = secret.trim();
    if (normalized.isEmpty || normalized.length > 4096) {
      throw ArgumentError.value(secret, 'secret', '密钥长度无效');
    }
    await _storage.write(key: _key(providerId), value: normalized);
  }

  @override
  Future<void> delete(String providerId) {
    return _storage.delete(key: _key(providerId));
  }
}
