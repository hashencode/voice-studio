import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android backup policies exclude every audio content root', () {
    final String manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();
    final String legacyRules = File(
      'android/app/src/main/res/xml/backup_rules.xml',
    ).readAsStringSync();
    final String extractionRules = File(
      'android/app/src/main/res/xml/data_extraction_rules.xml',
    ).readAsStringSync();

    expect(manifest, contains('android:fullBackupContent="@xml/backup_rules"'));
    expect(manifest, contains('android:allowBackup="false"'));
    expect(
      manifest,
      contains('android:dataExtractionRules="@xml/data_extraction_rules"'),
    );
    for (final String path in <String>['audios', 'recordings', 'exports']) {
      expect(legacyRules, contains('domain="file" path="$path"'));
      expect(extractionRules, contains('domain="file" path="$path"'));
    }
    expect(legacyRules, contains('domain="database" path="."'));
    expect(extractionRules, contains('domain="database" path="."'));
  });
}
