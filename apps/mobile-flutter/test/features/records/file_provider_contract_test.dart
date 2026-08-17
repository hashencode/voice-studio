import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'FileProvider exposes only the app-private managed export directory',
    () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();
      final paths = File(
        'android/app/src/main/res/xml/file_paths.xml',
      ).readAsStringSync();

      expect(
        manifest,
        contains('android:name="androidx.core.content.FileProvider"'),
      );
      expect(manifest, contains('android:exported="false"'));
      expect(manifest, contains('android:grantUriPermissions="true"'));
      expect(paths, contains('path="audios/exports/"'));
      expect(RegExp(r'<files-path\b').allMatches(paths), hasLength(1));
      expect(paths, isNot(contains('<root-path')));
      expect(paths, isNot(contains('<external-path')));
      expect(paths, isNot(contains('<external-files-path')));
      expect(paths, isNot(contains('path="."')));
      expect(paths, isNot(contains('path="/"')));
    },
  );
}
