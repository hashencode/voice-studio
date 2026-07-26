import 'package:meeting_core/meeting_core.dart';
import 'package:test/test.dart';

void main() {
  test('candidate validates the committed media identity', () {
    final candidate = MeetingMediaCandidate.fromMap(<Object?, Object?>{
      'path': '/private/meeting.m4a',
      'displayName': 'meeting.m4a',
      'sizeBytes': 4096,
      'durationMs': 12000,
      'fingerprintSha256': 'content-hash',
      'duplicateAsset': false,
    });

    expect(candidate.isValid, isTrue);
    expect(candidate.durationMs, 12000);
  });
}
