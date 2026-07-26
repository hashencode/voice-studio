import 'package:flutter/widgets.dart';

import '../features/home/home_page.dart';
import '../features/companion/companion_page.dart';
import '../features/help/help_page.dart';
import '../features/importing/service/meeting_import_service.dart';
import '../features/meetings/meeting_detail_page.dart';
import '../features/recording/recording_page.dart';
import '../features/recording/engine/recorder_port.dart';
import '../features/recording/service/recording_startup_reconciler.dart';
import '../features/records/records_page.dart';
import '../features/settings/settings_page.dart';
import '../features/transcription/transcription_page.dart';
import '../features/transcription/service/transcription_port.dart';
import '../features/transcription/service/transcription_queue_coordinator.dart';

class AppRoutes {
  static const String home = '/';
  static const String recording = '/recording';
  static const String transcription = '/transcription';
  static const String records = '/records';
  static const String settings = '/settings';
  static const String help = '/help';
  static const String companion = '/companion';
  static const String meetingDetail = '/meeting';

  static Map<String, WidgetBuilder> buildMap({
    required TranscriptionQueueCoordinator transcriptionQueueCoordinator,
    required MeetingImportService meetingImportService,
    required RecordingStartupReconciler recordingStartupReconciler,
    required RecorderPort recorderPort,
    required TranscriptionPort transcriptionPort,
    required bool notificationPermissionEnabled,
  }) => <String, WidgetBuilder>{
    home: (_) => HomePage(
      meetingImportService: meetingImportService,
      recordingStartupReconciler: recordingStartupReconciler,
      retryRecordings: transcriptionQueueCoordinator.retryRecordings,
    ),
    recording: (_) => RecordingPage(
      recorder: recorderPort,
      transcriptionPort: transcriptionPort,
      transcriptionQueueCoordinator: transcriptionQueueCoordinator,
      notificationPermissionEnabled: notificationPermissionEnabled,
    ),
    transcription: (_) =>
        TranscriptionPage(coordinator: transcriptionQueueCoordinator),
    records: (_) => const RecordsPage(),
    settings: (_) => const SettingsPage(),
    help: (_) => const HelpPage(),
    companion: (_) => const CompanionPage(),
    meetingDetail: (context) {
      final arguments =
          ModalRoute.of(context)?.settings.arguments as MeetingDetailArguments?;
      if (arguments == null) {
        return const _InvalidMeetingRoute();
      }
      return MeetingDetailPage(recordingId: arguments.recordingId);
    },
  };
}

class _InvalidMeetingRoute extends StatelessWidget {
  const _InvalidMeetingRoute();

  @override
  Widget build(BuildContext context) {
    return const Center(child: Text('缺少会议参数'));
  }
}
