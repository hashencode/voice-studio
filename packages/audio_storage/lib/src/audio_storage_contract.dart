/// Cross-runtime identity for the fresh-only Audio database boundary.
abstract final class AudioStorageContract {
  static const int schemaVersion = 1;
  static const String databaseFileName = 'audio.sqlite3';
  static const String profileVersion = 'v2';
  static const bool supportsLegacyMigration = false;
}
