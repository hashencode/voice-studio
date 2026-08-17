import 'dart:convert';

import 'package:flutter/services.dart';

class DiscoveredCompanionDesktop {
  const DiscoveredCompanionDesktop({
    required this.deviceId,
    required this.deviceName,
    required this.host,
    required this.port,
    required this.fingerprint,
  });

  final String deviceId;
  final String deviceName;
  final String host;
  final int port;
  final String fingerprint;
}

abstract interface class CompanionPlatformPort {
  Future<void> putCredential(String key, List<int> value);
  Future<List<int>?> getCredential(String key);
  Future<void> deleteCredential(String key);
  Future<void> deleteAllCredentials();
  Future<void> startDiscovery();
  Future<List<DiscoveredCompanionDesktop>> listDiscoveredDesktops();
  Future<void> stopDiscovery();
}

class AndroidCompanionPlatform implements CompanionPlatformPort {
  const AndroidCompanionPlatform({
    MethodChannel channel = const MethodChannel('voice2text/companion'),
  }) : _channel = channel;

  final MethodChannel _channel;

  @override
  Future<void> putCredential(String key, List<int> value) =>
      _channel.invokeMethod<void>('putCredential', <String, Object>{
        'key': key,
        'value': base64Encode(value),
      });

  @override
  Future<List<int>?> getCredential(String key) async {
    final encoded = await _channel.invokeMethod<String>(
      'getCredential',
      <String, Object>{'key': key},
    );
    return encoded == null ? null : base64Decode(encoded);
  }

  @override
  Future<void> deleteCredential(String key) => _channel.invokeMethod<void>(
    'deleteCredential',
    <String, Object>{'key': key},
  );

  @override
  Future<void> deleteAllCredentials() =>
      _channel.invokeMethod<void>('deleteAllCredentials');

  @override
  Future<void> startDiscovery() =>
      _channel.invokeMethod<void>('startDiscovery');

  @override
  Future<List<DiscoveredCompanionDesktop>> listDiscoveredDesktops() async {
    final raw =
        await _channel.invokeListMethod<Map<Object?, Object?>>(
          'listDiscoveredDesktops',
        ) ??
        const <Map<Object?, Object?>>[];
    return raw
        .map(
          (item) => DiscoveredCompanionDesktop(
            deviceId: item['deviceId']! as String,
            deviceName: item['deviceName']! as String,
            host: item['host']! as String,
            port: item['port']! as int,
            fingerprint: item['fingerprint']! as String,
          ),
        )
        .toList(growable: false);
  }

  @override
  Future<void> stopDiscovery() => _channel.invokeMethod<void>('stopDiscovery');
}
