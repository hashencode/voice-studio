import 'package:flutter/services.dart';

import 'import_transfer_port.dart';

class MacosNativeImportTransferPort implements DesktopImportTransferPort {
  const MacosNativeImportTransferPort({
    MethodChannel channel = const MethodChannel(_channelName),
  }) : _channel = channel;

  static const String _channelName =
      'com.voice2text.desktop/secure_local_import';

  final MethodChannel _channel;

  @override
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  ) async {
    try {
      final result = await _channel.invokeMapMethod<Object?, Object?>(
        'commitLocalMeetingFile',
        request.toMap(),
      );
      if (result == null) {
        throw const DesktopImportFailure(
          'IMPORT_NATIVE_RESULT_INVALID',
          '本地导入宿主没有返回结果',
        );
      }
      return DesktopImportTransferResult.fromMap(result);
    } on PlatformException catch (error) {
      throw DesktopImportFailure(error.code, error.message ?? '本地文件导入失败');
    }
  }

  @override
  Future<void> cancel() async {
    try {
      await _channel.invokeMethod<void>('cancelLocalMeetingImport');
    } on PlatformException {
      // A transfer that already committed remains authoritative.
    }
  }

  @override
  Future<void> discard(String committedPath) async {
    try {
      await _channel.invokeMethod<void>(
        'discardLocalMeetingFile',
        <String, Object?>{'path': committedPath},
      );
    } on PlatformException {
      // The startup orphan cleanup owns remnants that cannot be removed now.
    }
  }
}
