import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../features/importing/service/meeting_import_service.dart';
import '../features/recording/service/recording_startup_reconciler.dart';
import '../features/records/service/meeting_retention_service.dart';
import '../features/settings/repository/app_settings_repository.dart';
import '../features/transcription/repository/transcription_jobs_repository.dart';
import '../features/transcription/service/transcription_job_reconciler.dart';
import '../features/transcription/service/transcription_queue_coordinator.dart';
import 'logging/privacy_safe_log.dart';
import 'platform_composition.dart';
import 'router.dart';
import 'theme/app_theme.dart';
import 'theme/theme_mode_controller.dart';

class Voice2TextApp extends StatefulWidget {
  const Voice2TextApp({super.key});

  @override
  State<Voice2TextApp> createState() => _Voice2TextAppState();
}

class _Voice2TextAppState extends State<Voice2TextApp> {
  late final AppThemeModeController _themeController;
  late final AppPlatformComposition _platformComposition;
  late final TranscriptionQueueCoordinator _transcriptionQueueCoordinator;
  late final MeetingImportService _meetingImportService;
  late final RecordingStartupReconciler _recordingStartupReconciler;
  late final MeetingRetentionService _meetingRetentionService;

  @override
  void initState() {
    super.initState();
    _themeController = AppThemeModeController()..load();
    _platformComposition = AppPlatformComposition.forTarget(
      defaultTargetPlatform,
    );
    final jobsRepository = TranscriptionJobsRepository();
    _transcriptionQueueCoordinator = TranscriptionQueueCoordinator(
      repository: jobsRepository,
      transcriptionPort: _platformComposition.transcriptionPort,
      settingsRepository: AppSettingsRepository(),
      reconciler: TranscriptionJobReconciler(repository: jobsRepository),
    );
    _meetingImportService = MeetingImportService(
      mediaImportPort: _platformComposition.mediaImportPort,
      onQueueChanged: _transcriptionQueueCoordinator.kick,
    );
    _recordingStartupReconciler = RecordingStartupReconciler(
      recorder: _platformComposition.recorderPort,
      enabled: _platformComposition.recordingRecoveryEnabled,
      onQueueChanged: _transcriptionQueueCoordinator.kick,
    );
    _meetingRetentionService = MeetingRetentionService();
    unawaited(_startQueueSafely());
    unawaited(_scanRetentionSafely());
  }

  @override
  void dispose() {
    _themeController.dispose();
    _meetingImportService.dispose();
    unawaited(_transcriptionQueueCoordinator.dispose());
    super.dispose();
  }

  Future<void> _startQueueSafely() async {
    try {
      await _transcriptionQueueCoordinator.start();
    } catch (error) {
      PrivacySafeLog.info(
        'transcription_queue_startup_failed',
        <String, Object?>{'category': error.runtimeType.toString()},
      );
    }
  }

  Future<void> _scanRetentionSafely() async {
    try {
      final result = await _meetingRetentionService.scan();
      PrivacySafeLog.info('retention_scan_completed', <String, Object?>{
        'status': result.status.name,
        'examined': result.examinedCount,
        'deleted': result.deletedCount,
        'failed': result.failedCount,
        'hasMore': result.hasMore,
      });
    } catch (error) {
      PrivacySafeLog.info('retention_scan_failed', <String, Object?>{
        'category': error.runtimeType.toString(),
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppThemeModeScope(
      notifier: _themeController,
      child: AnimatedBuilder(
        animation: _themeController,
        builder: (BuildContext context, Widget? child) {
          return MaterialApp(
            title: 'Voice2Text',
            debugShowCheckedModeBanner: false,
            builder: (BuildContext context, Widget? child) {
              return GooToastScope(
                child: GooSnackbarScope(
                  child: child ?? const SizedBox.shrink(),
                ),
              );
            },
            theme: AppTheme.light(),
            darkTheme: AppTheme.dark(),
            themeMode: _themeController.themeMode,
            initialRoute: AppRoutes.home,
            routes: AppRoutes.buildMap(
              transcriptionQueueCoordinator: _transcriptionQueueCoordinator,
              meetingImportService: _meetingImportService,
              recordingStartupReconciler: _recordingStartupReconciler,
              recorderPort: _platformComposition.recorderPort,
              transcriptionPort: _platformComposition.transcriptionPort,
              notificationPermissionEnabled:
                  _platformComposition.notificationPermissionEnabled,
            ),
          );
        },
      ),
    );
  }
}
