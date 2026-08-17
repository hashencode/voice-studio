import 'package:audio_core/audio_core.dart';
import 'package:test/test.dart';

void main() {
  test('candidate validates the committed media identity', () {
    final candidate = AudioMediaCandidate.fromMap(<Object?, Object?>{
      'path': '/private/audio.m4a',
      'displayName': 'audio.m4a',
      'sizeBytes': 4096,
      'durationMs': 12000,
      'fingerprintSha256': 'content-hash',
      'duplicateAsset': false,
    });

    expect(candidate.isValid, isTrue);
    expect(candidate.durationMs, 12000);
  });
}
