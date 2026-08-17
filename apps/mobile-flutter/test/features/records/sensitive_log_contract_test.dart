import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/logging/privacy_safe_log.dart';

void main() {
  test('Dart formatter only emits allowlisted anonymous metadata', () {
    final formatted = PrivacySafeLog.format('transcription_failed', {
      'category': '/data/user/0/private/audio.m4a',
      'status': 'failed',
      'count': 2,
      'title': '董事会音频',
      'transcript': '敏感正文',
      'deviceSerial': 'stable-device-id',
    });

    expect(
      formatted,
      'event=transcription_failed '
      'category=redacted count=2 status=failed',
    );
    for (final sensitive in <String>[
      '/data/',
      '董事会音频',
      '敏感正文',
      'stable-device-id',
    ]) {
      expect(formatted, isNot(contains(sensitive)));
    }
  });

  test('production runtime logs cannot bypass privacy-safe wrappers', () {
    final dartFiles = _filesUnder('lib', '.dart')
      ..removeWhere((file) => file.path.endsWith('privacy_safe_log.dart'));
    final kotlinFiles = _filesUnder('android/app/src/main/kotlin', '.kt')
      ..removeWhere((file) => file.path.endsWith('PrivacySafeLog.kt'));

    for (final file in dartFiles) {
      final source = file.readAsStringSync();
      expect(
        RegExp(r'\b(?:debugPrint|print)\s*\(').hasMatch(source),
        isFalse,
        reason: file.path,
      );
    }
    for (final file in kotlinFiles) {
      final source = file.readAsStringSync();
      expect(
        RegExp(r'\bLog\.(?:v|d|i|w|e)\s*\(').hasMatch(source),
        isFalse,
        reason: file.path,
      );
    }
  });

  test('native structured log calls do not pass sensitive fields', () {
    final source = File(
      'android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt',
    ).readAsStringSync();
    final invocations = _extractInvocations(source, 'PrivacySafeLog.');

    expect(invocations, isNotEmpty);
    for (final invocation in invocations) {
      expect(
        invocation,
        isNot(
          matches(
            RegExp(
              r'\b(recordingPath|resultText|transcriptText|audioTitle|'
              r'filePath|displayName|uri|message)\b\s+to\b',
            ),
          ),
        ),
      );
    }
  });

  test('representative runtime lines contain no sensitive payloads', () {
    const safeLines = <String>[
      'event=transcribe_failed category=MODEL_LOAD_FAILED jobId=42 '
          'model=paraformer-zh stage=model_load',
      'event=picker_media_import_failed category=SecurityException',
      'event=retention_scan_completed deleted=2 examined=3 failed=1 '
          'hasMore=true status=partial',
    ];
    final forbidden = RegExp(
      r'(/data/|/storage/|content://|file://|recording_path|result_text|'
      r'transcript|audioTitle|deviceSerial|android_id|imei)',
      caseSensitive: false,
    );

    for (final line in safeLines) {
      expect(forbidden.hasMatch(line), isFalse, reason: line);
    }
  });
}

List<File> _filesUnder(String root, String suffix) {
  return Directory(root)
      .listSync(recursive: true)
      .whereType<File>()
      .where((file) => file.path.endsWith(suffix))
      .toList(growable: true);
}

List<String> _extractInvocations(String source, String prefix) {
  final results = <String>[];
  var searchFrom = 0;
  while (true) {
    final start = source.indexOf(prefix, searchFrom);
    if (start < 0) return results;
    final opening = source.indexOf('(', start);
    if (opening < 0) return results;
    var depth = 0;
    var end = opening;
    for (; end < source.length; end += 1) {
      final character = source[end];
      if (character == '(') depth += 1;
      if (character == ')') {
        depth -= 1;
        if (depth == 0) {
          results.add(source.substring(start, end + 1));
          searchFrom = end + 1;
          break;
        }
      }
    }
    if (end >= source.length) return results;
  }
}
