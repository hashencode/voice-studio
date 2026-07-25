import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';

class BuildInfo {
  BuildInfo({
    required this.packageName,
    required this.versionName,
    required this.lastUpdateTimeMs,
  });

  final String packageName;
  final String versionName;
  final int lastUpdateTimeMs;
}

class BuildInfoService {
  BuildInfoService()
    : _channel = const MethodChannel(AudioContract.recorderChannel);

  final MethodChannel _channel;
  Future<BuildInfo>? _cache;

  Future<BuildInfo> load() {
    _cache ??= _loadInternal();
    return _cache!;
  }

  Future<BuildInfo> _loadInternal() async {
    final Map<Object?, Object?>? map = await _channel
        .invokeMethod<Map<Object?, Object?>>('getBuildInfo');
    final packageName = (map?['packageName'] as String?) ?? 'unknown';
    final versionName = (map?['versionName'] as String?) ?? 'unknown';
    final lastUpdateTimeMs = (map?['lastUpdateTimeMs'] as int?) ?? 0;
    return BuildInfo(
      packageName: packageName,
      versionName: versionName,
      lastUpdateTimeMs: lastUpdateTimeMs,
    );
  }
}
