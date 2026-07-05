class AudioContract {
  static const String recorderChannel = 'voice2text/recorder';
  static const String transcriptionEventsChannel =
      'voice2text/transcription_events';

  static const String eventTypeSegment = 'segment';
  static const String eventTypeDegradation = 'degradation';
  static const String eventTypeSessionStarted = 'session_started';
  static const String eventTypeSessionStopped = 'session_stopped';

  static const String recordingDirName = 'recordings';
  static const String recordingExtension = 'm4a';
  static const String realtimeRecordingExtension = 'wav';

  static const int sampleRateHz = 16000;
  static const int bitRate = 64000;
  static const int channelCount = 1;

  static const String containerFormat = 'mpeg4';
  static const String codec = 'aac';

  // Keep this up-to-date with Android native implementation.
  static const String compatibilityNote =
      'Standard recorder output is m4a/aac @16kHz mono; realtime recorder output is wav/pcm16 @16kHz mono.';
}
