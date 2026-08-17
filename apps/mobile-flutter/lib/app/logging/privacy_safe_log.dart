import 'package:flutter/foundation.dart';

abstract final class PrivacySafeLog {
  static final RegExp _safeEvent = RegExp(r'^[a-z0-9_]{1,80}$');
  static final RegExp _safeToken = RegExp(r'^[A-Za-z0-9_.-]{1,80}$');
  static const Set<String> _allowedFields = <String>{
    'category',
    'count',
    'status',
    'examined',
    'deleted',
    'failed',
    'hasMore',
  };

  static void info(String event, [Map<String, Object?> fields = const {}]) {
    debugPrint(format(event, fields));
  }

  @visibleForTesting
  static String format(String event, [Map<String, Object?> fields = const {}]) {
    final safeName = _safeEvent.hasMatch(event) ? event : 'invalid_event';
    final entries =
        fields.entries
            .where(
              (entry) =>
                  _allowedFields.contains(entry.key) && entry.value != null,
            )
            .toList(growable: false)
          ..sort((left, right) => left.key.compareTo(right.key));
    final encoded = entries
        .map((entry) => '${entry.key}=${_safeValue(entry.value!)}')
        .join(' ');
    return encoded.isEmpty ? 'event=$safeName' : 'event=$safeName $encoded';
  }

  static String _safeValue(Object value) {
    if (value is num || value is bool) return value.toString();
    final text = value.toString();
    return _safeToken.hasMatch(text) ? text : 'redacted';
  }
}
