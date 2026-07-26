import 'dart:convert';

import 'package:processing_contracts/processing_contracts.dart';

class SidecarJsonlFramer {
  SidecarJsonlFramer({
    this.maximumLineBytes = sidecarMaximumJsonLineBytes,
    this.maximumTotalBytes = 16 * 1024 * 1024,
  });

  final int maximumLineBytes;
  final int maximumTotalBytes;
  final List<int> _pending = <int>[];
  int _totalBytes = 0;

  List<String> add(List<int> bytes) {
    _totalBytes += bytes.length;
    if (_totalBytes > maximumTotalBytes) {
      throw const SidecarProtocolException(
        'SIDECAR_OUTPUT_LIMIT',
        'Sidecar output exceeds the session byte limit.',
      );
    }
    final lines = <String>[];
    for (final byte in bytes) {
      if (byte == 10) {
        if (_pending.isEmpty) continue;
        if (_pending.length > maximumLineBytes) {
          throw const SidecarProtocolException(
            'SIDECAR_OUTPUT_LIMIT',
            'Sidecar JSONL message exceeds the byte limit.',
          );
        }
        try {
          lines.add(utf8.decode(_pending));
        } on FormatException {
          throw const SidecarProtocolException(
            'SIDECAR_INVALID_JSON',
            'Sidecar output is not valid UTF-8.',
          );
        }
        _pending.clear();
      } else {
        _pending.add(byte);
        if (_pending.length > maximumLineBytes) {
          throw const SidecarProtocolException(
            'SIDECAR_OUTPUT_LIMIT',
            'Sidecar JSONL message exceeds the byte limit.',
          );
        }
      }
    }
    return lines;
  }

  void close() {
    if (_pending.isNotEmpty) {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_JSON',
        'Sidecar closed stdout with an incomplete JSONL message.',
      );
    }
  }
}
