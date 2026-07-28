import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';

import '../features/companion/desktop_companion_repository.dart';
import '../features/companion/desktop_companion_service.dart';
import '../features/capture/desktop_capture_controller.dart';
import '../features/meetings/playback/desktop_meeting_playback.dart';
import '../features/security/desktop_disk_encryption.dart';
import '../features/settings/desktop_ai_provider_settings_repository.dart';
import 'desktop_home_model.dart';

enum DesktopWorkstationSection { library, tasks, companion, settings }

abstract interface class DesktopWorkstationModel implements DesktopHomeModel {
  DesktopWorkstationSection get section;
  List<MeetingWorkspaceSummary> get meetings;
  MeetingWorkspaceSnapshot? get selectedMeeting;
  List<MeetingWorkspaceSegment> get searchResults;
  String get searchQuery;
  bool get workspaceLoading;
  bool get processing;
  bool get installingModels;
  bool get localProcessingSupported;
  double get modelInstallProgress;
  ModelAssetInstallStatus get modelInstallStatus;
  bool get aiSecretConfigured;
  DesktopAiProviderSettings get aiProviderSettings;
  bool get aiProviderProbing;
  bool get aiGenerating;
  String? get aiMessage;
  bool get companionListening;
  int? get companionPort;
  String? get companionFingerprint;
  String? get companionMessage;
  DesktopCompanionPairingInvite? get companionPairingInvite;
  List<DesktopCompanionPeer> get companionPeers;
  List<DesktopCompanionTransferHistory> get companionHistory;
  DesktopDiskEncryptionStatus get diskEncryptionStatus;
  DesktopMeetingPlaybackController get playback;
  DesktopCaptureUiController get captureController;

  void selectSection(DesktopWorkstationSection section);
  void closeMeeting();
  Future<void> selectMeeting(int recordingId);
  Future<void> searchTranscript(String query);
  Future<void> saveSegment({required int segmentId, required String text});
  Future<void> undoTranscript();
  Future<void> redoTranscript();
  Future<void> renameSpeakers(Map<int, String> names);
  Future<void> mergeSpeakers({
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  });
  Future<void> assignSpeaker({
    required int segmentId,
    required int? speakerId,
    required MeetingWorkspaceSpeakerState state,
  });
  Future<String?> exportMeeting(MeetingWorkspaceExportFormat format);
  Future<void> installModels();
  Future<void> retryJob(int jobId);
  Future<void> cancelProcessing();
  Future<void> replaceAiSecret(String secret);
  Future<void> deleteAiSecret();
  Future<void> configureAiProvider(DesktopAiProviderSettings settings);
  Future<void> probeAiProvider();
  Future<void> generateAiNotes({required bool consentGranted});
  Future<void> reviewInsight({
    required int insightId,
    required String body,
    required bool publish,
  });
  Future<void> createCompanionPairingInvite();
  Future<void> refreshCompanion();
  Future<void> unpairCompanion(String deviceId);
}
