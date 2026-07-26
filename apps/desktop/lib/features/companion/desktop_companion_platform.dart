import 'package:flutter/services.dart';

abstract interface class DesktopCompanionDiscoveryPort {
  Future<void> register({
    required int port,
    required String deviceId,
    required String deviceName,
    required String fingerprint,
  });

  Future<void> unregister();
}

class MacosCompanionDiscoveryPort implements DesktopCompanionDiscoveryPort {
  const MacosCompanionDiscoveryPort({
    MethodChannel channel = const MethodChannel('voice2text/desktop_companion'),
  }) : _channel = channel;

  final MethodChannel _channel;

  @override
  Future<void> register({
    required int port,
    required String deviceId,
    required String deviceName,
    required String fingerprint,
  }) => _channel.invokeMethod<void>('register', <String, Object>{
    'port': port,
    'deviceId': deviceId,
    'deviceName': deviceName,
    'fingerprint': fingerprint,
  });

  @override
  Future<void> unregister() => _channel.invokeMethod<void>('unregister');
}
