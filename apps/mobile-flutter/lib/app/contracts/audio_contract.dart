class AudioContract {
  static const String recorderChannel = 'voice2text/recorder';
  static const String transcriptionEventChannel =
      'voice2text/transcription_events';

  static const String audioDirName = 'audios';
  static const String recordingDirName = 'recordings';
  static const String recordingInProgressDirName = 'in-progress';
  static const String recordingCompleteDirName = 'complete';
  static const String recordingJournalDirName = 'journals';
  static const String recordingJournalSuffix = '.journal.json';
  static const String importDirName = 'imports';
  static const String importInProgressDirName = 'in-progress';
  static const String importCompleteDirName = 'complete';
  static const String transcriptExportDirName = 'transcript-exports';
  static const String exportDirName = 'exports';
  static const String recordingExtension = 'm4a';
  static const String recordingStagingExtension = 'm4a.partial';

  static const int recordingConsentVersion = 1;
  static const int minimumStorageReserveBytes = 512 * 1024 * 1024;
  static const int storageCheckIntervalMs = 15000;
  static const int maximumImportedMediaBytes = 2 * 1024 * 1024 * 1024;
  static const int maximumImportedDurationMs = 4 * 60 * 60 * 1000;

  static const int sampleRateHz = 16000;
  static const int bitRate = 64000;
  static const int channelCount = 1;

  static const String containerFormat = 'mpeg4';
  static const String codec = 'aac';

  // Keep this up-to-date with Android native implementation.
  static const String compatibilityNote =
      'Standard recorder output is m4a/aac @16kHz mono.';
}
