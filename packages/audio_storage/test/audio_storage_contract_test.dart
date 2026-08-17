import 'package:audio_storage/audio_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Audio storage is a fresh-only v1 database in profile v2', () {
    expect(AudioStorageContract.schemaVersion, 1);
    expect(AudioStorageContract.databaseFileName, 'audio.sqlite3');
    expect(
      AudioStorageContract.retiredDatabaseFileName,
      'voice2text_flutter.db',
    );
    expect(AudioStorageContract.archiveDirectoryName, 'audio-legacy-archive');
    expect(AudioStorageContract.profileVersion, 'v2');
    expect(AudioStorageContract.supportsLegacyMigration, isFalse);
  });
}
