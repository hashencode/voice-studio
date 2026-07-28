import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../secrets/desktop_secret_store.dart';

class DesktopSecureSettings {
  DesktopSecureSettings({
    FlutterSecureStorage storage = const FlutterSecureStorage(
      mOptions: MacOsOptions(
        accountName: 'com.voice2text.desktop.meeting-ai',
        accessibility: KeychainAccessibility.unlocked_this_device,
        synchronizable: false,
        usesDataProtectionKeychain: true,
      ),
    ),
  }) : _store = KeychainDesktopSecretStore(storage: storage);

  DesktopSecureSettings.withStore(DesktopSecretStore store) : _store = store;

  final DesktopSecretStore _store;

  Future<bool> hasProviderSecret(String providerId) =>
      _store.contains(providerId);

  Future<String?> readProviderSecret(String providerId) =>
      _store.read(providerId);

  Future<void> writeProviderSecret(String providerId, String secret) async {
    final normalized = secret.trim();
    if (normalized.isEmpty) {
      await _store.delete(providerId);
      return;
    }
    await _store.replace(providerId, normalized);
  }

  Future<void> deleteProviderSecret(String providerId) =>
      _store.delete(providerId);
}
