import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';

import '../features/companion/desktop_companion_repository.dart';
import '../features/companion/desktop_companion_service.dart';
import '../features/importing/desktop_import_service.dart';
import '../features/importing/import_transfer_port.dart';
import '../features/meeting_intelligence/desktop_meeting_ai_repository.dart';
import '../features/meetings/export/desktop_meeting_export.dart';
import '../features/meetings/playback/desktop_meeting_playback.dart';
import '../features/processing/desktop_job.dart';
import '../features/processing/desktop_processing_engine.dart';
import '../features/processing/desktop_processing_repository.dart';
import '../features/processing/frozen_sherpa_model_manager.dart';
import '../features/security/desktop_disk_encryption.dart';
import '../features/processing/sherpa_desktop_processing_engine.dart';
import '../features/secrets/desktop_secret_store.dart';
import 'desktop_workstation_model.dart';

typedef DesktopEngineFactory =
    DesktopProcessingEngine Function(SherpaDesktopModelSet models);

class DesktopHomeController extends ChangeNotifier
    implements DesktopWorkstationModel {
  DesktopHomeController({
    required DesktopImportService importService,
    required DesktopProcessingRepository repository,
    required DesktopProcessingCoordinator processingCoordinator,
    required MeetingWorkspaceService workspaceService,
    required FrozenSherpaModelManager modelManager,
    required FrozenSherpaManifest modelManifest,
    required DesktopEngineFactory engineFactory,
    required DesktopMeetingAiRepository aiRepository,
    required DesktopSecretStore secretStore,
    required this.playback,
    DesktopCompanionService? companionService,
    DesktopMeetingExportPort exportPort =
        const FileSelectorDesktopMeetingExportPort(),
    ModelAssetInstallStatus initialModelStatus =
        ModelAssetInstallStatus.notInstalled,
    this.diskEncryptionStatus = DesktopDiskEncryptionStatus.unknown,
  }) : _importService = importService,
       _repository = repository,
       _processingCoordinator = processingCoordinator,
       _workspaceService = workspaceService,
       _modelManager = modelManager,
       _modelManifest = modelManifest,
       _engineFactory = engineFactory,
       _aiRepository = aiRepository,
       _secretStore = secretStore,
       _companionService = companionService,
       _exportPort = exportPort,
       _modelInstallStatus = initialModelStatus;

  final DesktopImportService _importService;
  final DesktopProcessingRepository _repository;
  final DesktopProcessingCoordinator _processingCoordinator;
  final MeetingWorkspaceService _workspaceService;
  final FrozenSherpaModelManager _modelManager;
  final FrozenSherpaManifest _modelManifest;
  final DesktopEngineFactory _engineFactory;
  final DesktopMeetingAiRepository _aiRepository;
  final DesktopSecretStore _secretStore;
  final DesktopCompanionService? _companionService;
  final DesktopMeetingExportPort _exportPort;

  @override
  final DesktopMeetingPlaybackController playback;

  @override
  final DesktopDiskEncryptionStatus diskEncryptionStatus;

  @override
  bool loading = true;

  @override
  bool importing = false;

  @override
  bool processing = false;

  @override
  bool installingModels = false;

  @override
  double modelInstallProgress = 0;

  ModelAssetInstallStatus _modelInstallStatus;

  @override
  ModelAssetInstallStatus get modelInstallStatus => _modelInstallStatus;

  @override
  bool get engineAvailable => _processingCoordinator.isAvailable;

  @override
  String get engineAvailabilityMessage =>
      _processingCoordinator.availabilityMessage;

  @override
  String? errorMessage;

  @override
  String? noticeMessage;

  @override
  List<DesktopProcessingJob> jobs = const [];

  @override
  DesktopWorkstationSection section = DesktopWorkstationSection.library;

  @override
  List<MeetingWorkspaceSummary> meetings = const [];

  @override
  MeetingWorkspaceSnapshot? selectedMeeting;

  @override
  List<MeetingWorkspaceSegment> searchResults = const [];

  @override
  String searchQuery = '';

  @override
  bool workspaceLoading = false;

  @override
  bool aiSecretConfigured = false;

  @override
  bool aiGenerating = false;

  @override
  String? aiMessage;

  @override
  bool companionListening = false;

  @override
  int? companionPort;

  @override
  String? companionFingerprint;

  @override
  String? companionMessage;

  @override
  DesktopCompanionPairingInvite? companionPairingInvite;

  @override
  List<DesktopCompanionPeer> companionPeers = const <DesktopCompanionPeer>[];

  @override
  List<DesktopCompanionTransferHistory> companionHistory =
      const <DesktopCompanionTransferHistory>[];

  Timer? _jobRefreshTimer;
  bool _disposed = false;

  @override
  Future<void> load() async {
    loading = true;
    errorMessage = null;
    notifyListeners();
    try {
      await _refreshLibrary();
      aiSecretConfigured = await _secretStore.contains('deepseek');
      final companion = _companionService;
      if (companion != null) {
        try {
          await companion.start();
          companionListening = true;
          companionPort = companion.port;
          companionFingerprint = companion.fingerprint;
          await refreshCompanion();
        } catch (_) {
          companionListening = false;
          companionMessage = '局域网接收器暂不可用；本机文件导入和会议处理不受影响';
        }
      }
    } catch (_) {
      errorMessage = '无法读取本机会议工作区';
    } finally {
      loading = false;
      notifyListeners();
    }
    if (engineAvailable &&
        jobs.any((job) => job.state == DesktopJobState.pending)) {
      unawaited(_drainQueue());
    }
  }

  @override
  Future<void> importMeeting() async {
    if (importing) return;
    importing = true;
    errorMessage = null;
    noticeMessage = null;
    notifyListeners();
    try {
      final outcome = await _importService.pickAndImport();
      if (outcome == null) return;
      noticeMessage = outcome.inserted ? '会议已安全导入并加入处理队列' : '此文件已导入，不会创建重复会议';
      await _refreshLibrary();
      if (outcome.inserted) {
        await selectMeeting(outcome.recordingId);
      }
      if (engineAvailable) unawaited(_drainQueue());
    } on DesktopImportFailure catch (failure) {
      errorMessage = failure.message;
    } catch (_) {
      errorMessage = '导入未完成，未创建半成品会议';
    } finally {
      importing = false;
      notifyListeners();
    }
  }

  @override
  void selectSection(DesktopWorkstationSection value) {
    if (section == value) return;
    section = value;
    notifyListeners();
    if (value == DesktopWorkstationSection.companion) {
      unawaited(refreshCompanion());
    }
  }

  @override
  Future<void> createCompanionPairingInvite() async {
    final companion = _companionService;
    if (companion == null || !companionListening) {
      companionMessage = '局域网接收器未运行';
      notifyListeners();
      return;
    }
    try {
      companionPairingInvite = await companion.createPairingInvite();
      companionMessage = '邀请将在两分钟后失效；请在手机核对相同的六位短码';
    } catch (_) {
      companionMessage = '无法生成配对邀请';
    }
    notifyListeners();
  }

  @override
  Future<void> refreshCompanion() async {
    final companion = _companionService;
    if (companion == null) return;
    companionPeers = await companion.listPeers();
    companionHistory = await companion.listHistory();
    if (!_disposed) notifyListeners();
  }

  @override
  Future<void> unpairCompanion(String deviceId) async {
    final companion = _companionService;
    if (companion == null) return;
    await companion.unpair(deviceId);
    companionPairingInvite = null;
    companionMessage = '已撤销设备并清理未完成 checkpoint；重新连接必须再次配对';
    await refreshCompanion();
  }

  @override
  void closeMeeting() {
    selectedMeeting = null;
    searchQuery = '';
    searchResults = const [];
    notifyListeners();
  }

  @override
  Future<void> selectMeeting(int recordingId) async {
    workspaceLoading = true;
    errorMessage = null;
    notifyListeners();
    try {
      final workspace = await _workspaceService.openMeeting(recordingId);
      if (workspace == null) throw StateError('meeting missing');
      selectedMeeting = workspace;
      searchQuery = '';
      searchResults = const [];
      await playback.open(workspace.summary.filePath);
    } catch (_) {
      errorMessage = '无法打开会议工作区';
    } finally {
      workspaceLoading = false;
      notifyListeners();
    }
  }

  @override
  Future<void> searchTranscript(String query) async {
    final meeting = selectedMeeting;
    if (meeting == null) return;
    searchQuery = query.trim();
    searchResults = searchQuery.isEmpty
        ? const []
        : await _workspaceService.searchTranscript(
            recordingId: meeting.summary.recordingId,
            query: searchQuery,
          );
    notifyListeners();
  }

  @override
  Future<void> saveSegment({
    required int segmentId,
    required String text,
  }) async {
    await _workspaceService.saveSegment(segmentId: segmentId, text: text);
    await _reloadSelected();
  }

  @override
  Future<void> undoTranscript() async {
    final generationId = selectedMeeting?.summary.generationId;
    if (generationId == null) return;
    if (await _workspaceService.undo(generationId)) await _reloadSelected();
  }

  @override
  Future<void> redoTranscript() async {
    final generationId = selectedMeeting?.summary.generationId;
    if (generationId == null) return;
    if (await _workspaceService.redo(generationId)) await _reloadSelected();
  }

  @override
  Future<void> renameSpeakers(Map<int, String> names) async {
    await _workspaceService.renameSpeakers(names);
    await _reloadSelected();
  }

  @override
  Future<void> mergeSpeakers({
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) async {
    final generationId = selectedMeeting?.summary.generationId;
    if (generationId == null) return;
    await _workspaceService.mergeSpeakers(
      generationId: generationId,
      targetSpeakerId: targetSpeakerId,
      sourceSpeakerIds: sourceSpeakerIds,
    );
    await _reloadSelected();
  }

  @override
  Future<void> assignSpeaker({
    required int segmentId,
    required int? speakerId,
    required MeetingWorkspaceSpeakerState state,
  }) async {
    final generationId = selectedMeeting?.summary.generationId;
    if (generationId == null) return;
    await _workspaceService.assignSpeaker(
      generationId: generationId,
      segmentId: segmentId,
      speakerId: speakerId,
      state: state,
    );
    await _reloadSelected();
  }

  @override
  Future<String?> exportMeeting(MeetingWorkspaceExportFormat format) async {
    final meeting = selectedMeeting;
    if (meeting == null) return null;
    final export = _workspaceService.export(meeting, format);
    final saved = await _exportPort.save(
      suggestedName: meeting.summary.displayName,
      export: export,
    );
    noticeMessage = saved == null ? null : '会议已导出到 $saved';
    notifyListeners();
    return saved;
  }

  @override
  Future<void> installModels() async {
    if (installingModels || engineAvailable) return;
    installingModels = true;
    _modelInstallStatus = ModelAssetInstallStatus.installing;
    modelInstallProgress = 0;
    errorMessage = null;
    notifyListeners();
    try {
      final installation = await _modelManager.install(
        _modelManifest,
        onProgress: (progress) {
          modelInstallProgress = progress;
          if (!_disposed) notifyListeners();
        },
      );
      _processingCoordinator.replaceEngine(_engineFactory(installation.models));
      _modelInstallStatus = ModelAssetInstallStatus.installed;
      modelInstallProgress = 1;
      noticeMessage = 'macOS 准入模型已安装并通过哈希验证';
      await _refreshLibrary();
      unawaited(_drainQueue());
    } catch (_) {
      _modelInstallStatus = ModelAssetInstallStatus.corrupt;
      errorMessage = '模型安装未完成；已保留可恢复下载，不会启用未验证文件';
    } finally {
      installingModels = false;
      notifyListeners();
    }
  }

  @override
  Future<void> retryJob(int jobId) async {
    if (await _repository.retry(jobId)) {
      await _refreshLibrary();
      if (engineAvailable) unawaited(_drainQueue());
    }
  }

  @override
  Future<void> cancelProcessing() async {
    await _processingCoordinator.cancelActive();
    await _refreshLibrary();
    notifyListeners();
  }

  @override
  Future<void> replaceAiSecret(String secret) async {
    await _secretStore.replace('deepseek', secret);
    aiSecretConfigured = true;
    aiMessage = 'DeepSeek 密钥已替换并保存在 macOS 钥匙串';
    notifyListeners();
  }

  @override
  Future<void> deleteAiSecret() async {
    await _secretStore.delete('deepseek');
    aiSecretConfigured = false;
    aiMessage = 'DeepSeek 密钥已从 macOS 钥匙串删除';
    notifyListeners();
  }

  @override
  Future<void> generateAiNotes({required bool consentGranted}) async {
    final meeting = selectedMeeting;
    final generationId = meeting?.summary.generationId;
    if (meeting == null || generationId == null || aiGenerating) return;
    aiGenerating = true;
    aiMessage = null;
    notifyListeners();
    try {
      await _aiRepository.generate(
        MeetingAiRequest(
          recordingId: meeting.summary.recordingId,
          generationId: generationId,
          consent: consentGranted
              ? MeetingAiConsent.granted
              : MeetingAiConsent.denied,
          segments: meeting.segments,
          meetingTitle: meeting.summary.displayName,
        ),
      );
      aiMessage = '会议笔记草稿已生成；请逐条核对证据后发布';
      await _reloadSelected();
    } on MeetingAiFailure catch (failure) {
      aiMessage = failure.message;
    } catch (_) {
      aiMessage = '会议笔记生成失败；本机音频与转写不受影响';
    } finally {
      aiGenerating = false;
      notifyListeners();
    }
  }

  @override
  Future<void> reviewInsight({
    required int insightId,
    required String body,
    required bool publish,
  }) async {
    await _aiRepository.reviewInsight(
      insightId: insightId,
      body: body,
      publish: publish,
    );
    await _reloadSelected();
  }

  Future<void> _drainQueue() async {
    if (processing || !engineAvailable) return;
    processing = true;
    _startJobRefresh();
    notifyListeners();
    try {
      while (await _processingCoordinator.processNext()) {
        await _refreshLibrary();
        await _reloadSelected(notify: false);
      }
    } finally {
      processing = false;
      _jobRefreshTimer?.cancel();
      _jobRefreshTimer = null;
      await _refreshLibrary();
      await _reloadSelected(notify: false);
      notifyListeners();
    }
  }

  void _startJobRefresh() {
    _jobRefreshTimer?.cancel();
    _jobRefreshTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      unawaited(_refreshJobsAndNotify());
    });
  }

  Future<void> _refreshJobsAndNotify() async {
    jobs = await _repository.listJobs();
    if (!_disposed) notifyListeners();
  }

  Future<void> _refreshLibrary() async {
    final results = await Future.wait<Object>([
      _repository.listJobs(),
      _workspaceService.listMeetings(),
    ]);
    jobs = results[0] as List<DesktopProcessingJob>;
    meetings = results[1] as List<MeetingWorkspaceSummary>;
  }

  Future<void> _reloadSelected({bool notify = true}) async {
    final recordingId = selectedMeeting?.summary.recordingId;
    if (recordingId == null) return;
    selectedMeeting = await _workspaceService.openMeeting(recordingId);
    if (searchQuery.isNotEmpty) {
      searchResults = await _workspaceService.searchTranscript(
        recordingId: recordingId,
        query: searchQuery,
      );
    }
    if (notify && !_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _jobRefreshTimer?.cancel();
    playback.dispose();
    unawaited(_companionService?.stop());
    super.dispose();
  }
}
