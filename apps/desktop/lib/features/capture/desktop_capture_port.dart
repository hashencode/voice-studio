import 'dart:async';

import 'package:flutter/services.dart';

import 'desktop_capture_models.dart';

enum DesktopCaptureMenuAction { pause, resume, stop }

abstract interface class DesktopCapturePort {
  Stream<DesktopCaptureSessionSnapshot> get snapshots;
  Stream<DesktopCaptureMenuAction> get menuActions;

  Future<DesktopCapturePreflight> preflight({
    required String sessionRoot,
    required int minimumFreeBytes,
    required bool captionModelAvailable,
    bool requestPermissions = false,
  });

  Future<DesktopCaptureSessionSnapshot> start(
    DesktopCaptureStartRequest request,
  );

  Future<DesktopCaptureSessionSnapshot> pause({
    required String sessionId,
    required String idempotencyKey,
  });

  Future<DesktopCaptureSessionSnapshot> resume({
    required String sessionId,
    required String idempotencyKey,
  });

  Future<DesktopCaptureSessionSnapshot> stop({
    required String sessionId,
    required String idempotencyKey,
  });

  Future<List<DesktopCaptureSessionSnapshot>> recoverableSessions({
    required String captureRoot,
  });
}

class DesktopCaptureFailure implements Exception {
  const DesktopCaptureFailure(this.code, this.message, {this.details});

  final String code;
  final String message;
  final Object? details;

  @override
  String toString() {
    final suffix = details == null ? '' : ', details: $details';
    return 'DesktopCaptureFailure($code, $message$suffix)';
  }
}

class MacosDesktopCapturePort implements DesktopCapturePort {
  MacosDesktopCapturePort({
    MethodChannel channel = const MethodChannel(_channelName),
    EventChannel events = const EventChannel(_eventChannelName),
  }) : _channel = channel,
       _events = events {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  static const _channelName = 'com.voice2text.desktop/capture';
  static const _eventChannelName = 'com.voice2text.desktop/capture_events';

  final MethodChannel _channel;
  final EventChannel _events;
  final StreamController<DesktopCaptureMenuAction> _menuActions =
      StreamController<DesktopCaptureMenuAction>.broadcast();
  Stream<DesktopCaptureSessionSnapshot>? _snapshots;

  @override
  Stream<DesktopCaptureMenuAction> get menuActions => _menuActions.stream;

  @override
  Stream<DesktopCaptureSessionSnapshot> get snapshots {
    return _snapshots ??= _events
        .receiveBroadcastStream()
        .map(
          (event) => DesktopCaptureSessionSnapshot.fromMap(
            (event as Map).cast<Object?, Object?>(),
          ),
        )
        .asBroadcastStream();
  }

  @override
  Future<DesktopCapturePreflight> preflight({
    required String sessionRoot,
    required int minimumFreeBytes,
    required bool captionModelAvailable,
    bool requestPermissions = false,
  }) async {
    final result = await _invokeMap('preflight', <String, Object?>{
      'sessionRoot': sessionRoot,
      'minimumFreeBytes': minimumFreeBytes,
      'captionModelAvailable': captionModelAvailable,
      'requestPermissions': requestPermissions,
    });
    return DesktopCapturePreflight.fromMap(result);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> start(
    DesktopCaptureStartRequest request,
  ) async {
    return DesktopCaptureSessionSnapshot.fromMap(
      await _invokeMap('start', request.toMap()),
    );
  }

  @override
  Future<DesktopCaptureSessionSnapshot> pause({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    return _control('pause', sessionId, idempotencyKey);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> resume({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    return _control('resume', sessionId, idempotencyKey);
  }

  @override
  Future<DesktopCaptureSessionSnapshot> stop({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    return _control('stop', sessionId, idempotencyKey);
  }

  Future<DesktopCaptureSessionSnapshot> _control(
    String method,
    String sessionId,
    String idempotencyKey,
  ) async {
    return DesktopCaptureSessionSnapshot.fromMap(
      await _invokeMap(method, <String, Object?>{
        'sessionId': sessionId,
        'idempotencyKey': idempotencyKey,
      }),
    );
  }

  @override
  Future<List<DesktopCaptureSessionSnapshot>> recoverableSessions({
    required String captureRoot,
  }) async {
    try {
      final result = await _channel.invokeListMethod<Object?>(
        'recoverableSessions',
        <String, Object?>{'captureRoot': captureRoot},
      );
      return (result ?? const <Object?>[])
          .map(
            (value) => DesktopCaptureSessionSnapshot.fromMap(
              (value as Map).cast<Object?, Object?>(),
            ),
          )
          .toList(growable: false);
    } on PlatformException catch (error) {
      throw DesktopCaptureFailure(
        error.code,
        error.message ?? 'macOS capture request failed',
        details: error.details,
      );
    }
  }

  Future<Map<Object?, Object?>> _invokeMap(
    String method,
    Map<String, Object?> arguments,
  ) async {
    try {
      final result = await _channel.invokeMapMethod<Object?, Object?>(
        method,
        arguments,
      );
      if (result == null) {
        throw const DesktopCaptureFailure(
          'CAPTURE_RESULT_INVALID',
          'macOS capture returned no result',
        );
      }
      return result;
    } on PlatformException catch (error) {
      throw DesktopCaptureFailure(
        error.code,
        error.message ?? 'macOS capture request failed',
        details: error.details,
      );
    }
  }

  Future<Object?> _handleNativeCall(MethodCall call) async {
    if (call.method != 'menuAction') return null;
    final arguments = (call.arguments as Map?)?.cast<Object?, Object?>();
    final action = switch (arguments?['action']) {
      'pause' => DesktopCaptureMenuAction.pause,
      'resume' => DesktopCaptureMenuAction.resume,
      'stop' => DesktopCaptureMenuAction.stop,
      _ => null,
    };
    if (action != null) _menuActions.add(action);
    return null;
  }
}
