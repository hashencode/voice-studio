import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class DesktopCompanionCredentialPort {
  Future<List<int>?> read(String key);
  Future<void> write(String key, List<int> value);
  Future<void> delete(String key);
}

class DesktopCompanionCredentialStore
    implements DesktopCompanionCredentialPort {
  const DesktopCompanionCredentialStore({
    FlutterSecureStorage storage = const FlutterSecureStorage(
      mOptions: MacOsOptions(
        accountName: 'com.voice2text.desktop.companion',
        accessibility: KeychainAccessibility.unlocked_this_device,
        synchronizable: false,
        usesDataProtectionKeychain: true,
      ),
    ),
  }) : _storage = storage;

  final FlutterSecureStorage _storage;

  @override
  Future<List<int>?> read(String key) async {
    final encoded = await _storage.read(key: _key(key));
    return encoded == null ? null : base64Decode(encoded);
  }

  @override
  Future<void> write(String key, List<int> value) {
    if (value.isEmpty || value.length > 4096) {
      throw ArgumentError.value(value.length, 'value');
    }
    return _storage.write(key: _key(key), value: base64Encode(value));
  }

  @override
  Future<void> delete(String key) => _storage.delete(key: _key(key));

  static String _key(String raw) {
    if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$').hasMatch(raw)) {
      throw ArgumentError.value(raw, 'key');
    }
    return 'companion.$raw';
  }
}
