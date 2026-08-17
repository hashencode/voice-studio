import 'dart:async';

import 'package:flutter/services.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_workflows/meeting_workflows.dart';

import '../../../app/contracts/audio_contract.dart';

export 'package:meeting_workflows/meeting_workflows.dart'
    show MeetingMediaImportPort;

class AndroidMeetingMediaImportPort implements MeetingMediaImportPort {
  AndroidMeetingMediaImportPort({MethodChannel? channel})
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
      return await _channel.invokeMethod<bool>(
            'hasPendingSharedMeetingMedia',
          ) ??
          false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<MeetingMediaCandidate?> pickMeetingMedia() =>
      _readCandidate('pickMeetingMedia');

  @override
  Future<MeetingMediaCandidate?> consumeSharedMeetingMedia() =>
      _readCandidate('consumeSharedMeetingMedia');

  Future<MeetingMediaCandidate?> _readCandidate(String method) async {
    final raw = await _channel.invokeMapMethod<Object?, Object?>(method);
    return raw == null ? null : MeetingMediaCandidate.fromMap(raw);
  }

  @override
  Future<void> cancelImport() async {
    try {
      await _channel.invokeMethod<void>('cancelMeetingImport');
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
    if (call.method == 'sharedMeetingMediaAvailable' &&
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

class UnavailableMeetingMediaImportPort implements MeetingMediaImportPort {
  const UnavailableMeetingMediaImportPort();

  UnsupportedError _unavailable() => UnsupportedError(
    'Meeting media import is not configured for this platform composition.',
  );

  @override
  bool get isAvailable => false;

  @override
  Stream<void> get sharedMediaAvailable => const Stream<void>.empty();

  @override
  Future<bool> hasPendingSharedImport() async => false;

  @override
  Future<MeetingMediaCandidate?> pickMeetingMedia() async =>
      throw _unavailable();

  @override
  Future<MeetingMediaCandidate?> consumeSharedMeetingMedia() async =>
      throw _unavailable();

  @override
  Future<void> cancelImport() async {}

  @override
  Future<void> discardImportedMedia(String path) async {}

  @override
  void dispose() {}
}
