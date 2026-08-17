import 'dart:async';

import 'package:flutter/services.dart';
import 'package:audio_core/audio_core.dart';
import 'package:audio_workflows/audio_workflows.dart';

import '../../../app/contracts/audio_contract.dart';

export 'package:audio_workflows/audio_workflows.dart' show AudioMediaImportPort;

class AndroidAudioMediaImportPort implements AudioMediaImportPort {
  AndroidAudioMediaImportPort({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(AudioContract.recorderChannel) {
    _channel.setMethodCallHandler(_handleNativeMethod);
  }

  final MethodChannel _channel;
  final StreamController<void> _sharedMediaAvailableController =
      StreamController<void>.broadcast();

  @override
  bool get isAvailable => true;

  @override
  Stream<void> get sharedMediaAvailable =>
      _sharedMediaAvailableController.stream;

  @override
  Future<bool> hasPendingSharedImport() async {
    try {
      return await _channel.invokeMethod<bool>('hasPendingSharedAudioMedia') ??
          false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<AudioMediaCandidate?> pickAudioMedia() =>
      _readCandidate('pickAudioMedia');

  @override
  Future<AudioMediaCandidate?> consumeSharedAudioMedia() =>
      _readCandidate('consumeSharedAudioMedia');

  Future<AudioMediaCandidate?> _readCandidate(String method) async {
    final raw = await _channel.invokeMapMethod<Object?, Object?>(method);
    return raw == null ? null : AudioMediaCandidate.fromMap(raw);
  }

  @override
  Future<void> cancelImport() async {
    try {
      await _channel.invokeMethod<void>('cancelAudioImport');
    } on PlatformException {
      // A completed native copy remains authoritative if cancellation races it.
    }
  }

  @override
  Future<void> discardImportedMedia(String path) async {
    await _channel.invokeMethod<void>('discardImportedMedia', <String, Object?>{
      'path': path,
    });
  }

  Future<Object?> _handleNativeMethod(MethodCall call) async {
    if (call.method == 'sharedAudioMediaAvailable' &&
        !_sharedMediaAvailableController.isClosed) {
      _sharedMediaAvailableController.add(null);
    }
    return null;
  }

  @override
  void dispose() {
    _channel.setMethodCallHandler(null);
    _sharedMediaAvailableController.close();
  }
}

class UnavailableAudioMediaImportPort implements AudioMediaImportPort {
  const UnavailableAudioMediaImportPort();

  UnsupportedError _unavailable() => UnsupportedError(
    'Audio media import is not configured for this platform composition.',
  );

  @override
  bool get isAvailable => false;

  @override
  Stream<void> get sharedMediaAvailable => const Stream<void>.empty();

  @override
  Future<bool> hasPendingSharedImport() async => false;

  @override
  Future<AudioMediaCandidate?> pickAudioMedia() async => throw _unavailable();

  @override
  Future<AudioMediaCandidate?> consumeSharedAudioMedia() async =>
      throw _unavailable();

  @override
  Future<void> cancelImport() async {}

  @override
  Future<void> discardImportedMedia(String path) async {}

  @override
  void dispose() {}
}
