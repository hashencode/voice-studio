import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android accepts single shared audio and video media', () {
    final manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();

    expect(manifest, contains('android.intent.action.SEND'));
    expect(manifest, contains('android.intent.category.DEFAULT'));
    expect(manifest, contains('android:mimeType="audio/*"'));
    expect(manifest, contains('android:mimeType="video/*"'));
    expect(manifest, isNot(contains('android.intent.action.SEND_MULTIPLE')));
  });

  test('cold and warm share intents enter the same queued import path', () {
    final activity = File(
      'android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt',
    ).readAsStringSync();

    expect(activity, contains('captureSharedIntent(intent)'));
    expect(activity, contains('override fun onNewIntent(intent: Intent)'));
    expect(activity, contains('"consumeSharedMeetingMedia"'));
    expect(activity, contains('"sharedMeetingMediaAvailable"'));
  });
}
