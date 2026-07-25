import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android backup and transfer exclude all app data categories', () {
    final manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();
    final legacy = File(
      'android/app/src/main/res/xml/backup_rules.xml',
    ).readAsStringSync();
    final extraction = File(
      'android/app/src/main/res/xml/data_extraction_rules.xml',
    ).readAsStringSync();

    expect(manifest, contains('android:allowBackup="false"'));
    expect(manifest, contains('android:fullBackupContent="@xml/backup_rules"'));
    expect(
      manifest,
      contains('android:dataExtractionRules="@xml/data_extraction_rules"'),
    );

    for (final rule in const <String>[
      '<exclude domain="root" path="." />',
      '<exclude domain="database" path="." />',
      '<exclude domain="sharedpref" path="." />',
      '<exclude domain="file" path="meetings" />',
      '<exclude domain="file" path="logs" />',
      '<exclude domain="file" path="diagnostics" />',
      '<exclude domain="external" path="." />',
      '<exclude domain="device_root" path="." />',
      '<exclude domain="device_database" path="." />',
      '<exclude domain="device_sharedpref" path="." />',
      '<exclude domain="device_file" path="." />',
    ]) {
      expect(legacy, contains(rule), reason: 'legacy rule: $rule');
      expect(
        rule.allMatches(extraction),
        hasLength(2),
        reason: 'cloud and device-transfer rule: $rule',
      );
    }
  });

  test(
    'platform capability contract avoids encryption and device ID claims',
    () {
      final source = File(
        'android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt',
      ).readAsStringSync();
      final handler = _methodBody(source, 'handleGetDeviceProtection');

      expect(source, contains('"getDeviceProtection"'));
      expect(handler, contains('"storageScope" to "app_private_internal"'));
      expect(
        handler,
        contains('"protectionCategory" to "device_security_managed"'),
      );
      expect(handler, contains('"protectionSummary" to "由设备安全设置保护"'));
      expect(handler, contains('"applicationLayerEncryption" to false'));
      expect(handler, contains('"platformEncryptionStatus" to "not_exposed"'));
      expect(handler, contains('"stableDeviceIdentifierIncluded" to false'));
      expect(
        handler.toLowerCase(),
        isNot(
          anyOf(contains('android_id'), contains('serial'), contains('imei')),
        ),
      );
    },
  );
}

String _methodBody(String source, String methodName) {
  final start = source.indexOf('private fun $methodName');
  expect(start, isNonNegative);
  final nextMethod = source.indexOf('\n    private fun ', start + 1);
  return source.substring(start, nextMethod < 0 ? source.length : nextMethod);
}
