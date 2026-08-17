import 'package:audio_storage/audio_storage.dart';
import 'package:test/test.dart';

void main() {
  test('Audio storage is a fresh-only v1 database in profile v2', () {
    expect(AudioStorageContract.schemaVersion, 1);
    expect(AudioStorageContract.databaseFileName, 'audio.sqlite3');
    expect(AudioStorageContract.profileVersion, 'v2');
    expect(AudioStorageContract.supportsLegacyMigration, isFalse);
  });
}
