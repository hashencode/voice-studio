import 'dart:io';

import '../../settings/repository/app_settings_repository.dart';
import '../engine/android_recorder_engine.dart';
import '../engine/recorder_port.dart';
import '../repository/recording_sessions_repository.dart';
import 'recording_recovery_coordinator.dart';

class RecordingStartupReconciler {
  RecordingStartupReconciler({
    RecorderPort? recorder,
    RecordingSessionsRepository? sessionsRepository,
    AppSettingsRepository? settingsRepository,
    void Function()? onQueueChanged,
    bool? enabled,
  }) : _recorder = recorder ?? AndroidRecorderEngine(),
       _sessionsRepository =
           sessionsRepository ?? RecordingSessionsRepository(),
       _settingsRepository = settingsRepository ?? AppSettingsRepository(),
       _onQueueChanged = onQueueChanged,
       _enabled = enabled ?? (recorder != null || Platform.isAndroid);

  final RecorderPort _recorder;
  final RecordingSessionsRepository _sessionsRepository;
  final AppSettingsRepository _settingsRepository;
  final void Function()? _onQueueChanged;
  final bool _enabled;

  Future<void> reconcile() async {
    if (!_enabled) return;
    final coordinator = RecordingRecoveryCoordinator(
      recorder: _recorder,
      sessionsRepository: _sessionsRepository,
    );
    final settings = await _settingsRepository.load();
    await coordinator.reattach(enqueueTranscription: settings.autoTranscribe);
    await coordinator.refresh();
    if (settings.autoTranscribe) {
      _onQueueChanged?.call();
    }
  }
}
