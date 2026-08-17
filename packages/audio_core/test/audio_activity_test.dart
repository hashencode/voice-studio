import 'package:audio_core/audio_core.dart';
import 'package:test/test.dart';

void main() {
  test('Audio ids are bounded protocol-safe activity identities', () {
    expect(AudioId('audio-1').value, 'audio-1');
    expect(() => AudioId(''), throwsFormatException);
    expect(() => AudioId('audio item'), throwsFormatException);
    expect(() => AudioId('a' * 129), throwsFormatException);
  });
}
