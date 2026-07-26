import 'package:flutter/foundation.dart';

import '../features/importing/service/meeting_media_import_port.dart';
import '../features/recording/engine/android_recorder_engine.dart';
import '../features/recording/engine/recorder_port.dart';
import '../features/recording/engine/unavailable_recorder_engine.dart';
import '../features/transcription/service/android_transcription_service.dart';
import '../features/transcription/service/transcription_port.dart';
import '../features/transcription/service/unavailable_transcription_service.dart';

class AppPlatformComposition {
  const AppPlatformComposition({
    required this.transcriptionPort,
    required this.recorderPort,
    required this.mediaImportPort,
    required this.recordingRecoveryEnabled,
    required this.notificationPermissionEnabled,
  });

  factory AppPlatformComposition.forTarget(TargetPlatform target) {
    if (target == TargetPlatform.android) {
      return AppPlatformComposition(
        transcriptionPort: AndroidTranscriptionService(),
        recorderPort: AndroidRecorderEngine(),
        mediaImportPort: AndroidMeetingMediaImportPort(),
        recordingRecoveryEnabled: true,
        notificationPermissionEnabled: true,
      );
    }
    final platform = target.name;
    return AppPlatformComposition(
      transcriptionPort: UnavailableTranscriptionService(platform: platform),
      recorderPort: UnavailableRecorderEngine(platform: platform),
      mediaImportPort: const UnavailableMeetingMediaImportPort(),
      recordingRecoveryEnabled: false,
      notificationPermissionEnabled: false,
    );
  }

  final TranscriptionPort transcriptionPort;
  final RecorderPort recorderPort;
  final MeetingMediaImportPort mediaImportPort;
  final bool recordingRecoveryEnabled;
  final bool notificationPermissionEnabled;
}
