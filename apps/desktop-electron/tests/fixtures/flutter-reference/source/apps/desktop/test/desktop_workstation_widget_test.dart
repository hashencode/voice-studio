import 'dart:async';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/app/desktop_app.dart';
import 'package:voice2text_desktop/app/desktop_workstation_model.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_repository.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_service.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_controller.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';
import 'package:voice2text_desktop/features/meetings/playback/desktop_meeting_playback.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';
import 'package:voice2text_desktop/features/security/desktop_disk_encryption.dart';
import 'package:voice2text_desktop/features/settings/desktop_ai_provider_settings_repository.dart';

void main() {
  testWidgets('library is the default responsive workstation section', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final model = _WorkstationModel();
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();

    expect(find.text('本机会议'), findsOneWidget);
    expect(find.text('开始会议'), findsOneWidget);
    expect(find.text('导入文件'), findsOneWidget);
    expect(find.text('会议'), findsWidgets);
    expect(find.text('任务'), findsWidgets);
    expect(find.text('设置'), findsWidgets);
    expect(find.textContaining('模拟转写'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('3000+ transcript remains virtualized and usable at 200% text', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 1050));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() {
      tester.binding.setSurfaceSize(null);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
    final model = _WorkstationModel(selectedMeeting: _longWorkspace());
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('transcript_virtual_list')),
      findsOneWidget,
    );
    expect(find.text('片段 0'), findsOneWidget);
    expect(find.text('片段 2999'), findsNothing);
    expect(find.text('转写与说话人'), findsOneWidget);
    expect(find.text('会议笔记'), findsOneWidget);
    expect(find.bySemanticsLabel('会议音频时间轴'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('settings is truthful in dark mode and keyboard reachable', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(() {
      tester.binding.setSurfaceSize(null);
      tester.platformDispatcher.clearPlatformBrightnessTestValue();
    });
    final model = _WorkstationModel(
      section: DesktopWorkstationSection.settings,
    );
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();

    expect(
      Theme.of(tester.element(find.text('设置').last)).brightness,
      Brightness.dark,
    );
    expect(find.text('FileVault 磁盘加密未启用'), findsOneWidget);
    expect(find.textContaining('没有应用层整库加密'), findsOneWidget);
    expect(find.text('检查配置'), findsOneWidget);
    await tester.tap(find.text('配置'));
    await tester.pumpAndSettle();
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('开放接口'), findsOneWidget);
    expect(find.text('Ollama'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    expect(FocusManager.instance.primaryFocus, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('older macOS warns only when local processing is requested', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final model = _WorkstationModel(
      section: DesktopWorkstationSection.settings,
      engineAvailable: false,
      localProcessingSupported: false,
    );
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();
    await tester.tap(find.text('安装模型'));
    await tester.pump();

    expect(find.textContaining('本地离线转写需要 macOS 15.5'), findsOneWidget);
    expect(model.installModelCalls, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'task area renders every required processing and recovery state',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final model = _WorkstationModel(
        section: DesktopWorkstationSection.tasks,
        jobs: _stateJobs(),
      );
      addTearDown(model.dispose);

      await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
      await tester.pumpAndSettle();

      for (final label in const <String>[
        '缺少准入模型',
        '正在安装模型',
        '已入队',
        '正在准备隔离工作进程',
        '正在本机识别',
        '正在本机分离说话人',
        '转写已保留，说话人分离可重试',
        '处理完成',
        '正在终止隔离工作进程',
        '已取消',
        '处理失败，可重试',
        '处理失败，无法自动重试',
        '应用重启后状态待确认，可安全重试',
      ]) {
        await tester.scrollUntilVisible(
          find.textContaining(label).first,
          120,
          scrollable: find.byType(Scrollable).last,
        );
        expect(find.textContaining(label), findsWidgets);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'companion pairing and receipt history remain usable at 200% text',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(() {
        tester.binding.setSurfaceSize(null);
        tester.platformDispatcher.clearTextScaleFactorTestValue();
      });
      final receipt = CompanionReceipt(
        receiptId: 'receipt-transfer-1',
        transferId: 'transfer-1',
        wholeFileSha256: 'a'.padRight(64, 'a'),
        sizeBytes: 8192,
        desktopDeviceId: 'desktop-1',
        desktopDeviceName: 'Studio Mac',
        desktopRecordingId: 42,
        committedAtMs: 1000,
        signature: 'signed-receipt-value',
      );
      final model = _WorkstationModel(
        section: DesktopWorkstationSection.companion,
        companionInvite: const DesktopCompanionPairingInvite(
          pairingId: 'pairing-1',
          shortCode: '123456',
          encodedPayload: 'bounded-pairing-qr-payload',
          expiresAtMs: 2000,
        ),
        companionPeers: <DesktopCompanionPeer>[
          DesktopCompanionPeer(
            deviceId: 'mobile-1',
            displayName: 'Test Phone',
            fingerprint: 'M'.padRight(32, 'M'),
            trustState: 'active',
            pairedAtMs: 1,
          ),
        ],
        companionHistory: <DesktopCompanionTransferHistory>[
          DesktopCompanionTransferHistory(
            transferId: 'transfer-1',
            displayName: 'meeting.wav',
            wholeFileSha256: receipt.wholeFileSha256,
            sizeBytes: receipt.sizeBytes,
            state: 'committed',
            createdAtMs: 1,
            recordingId: 42,
            receipt: receipt,
          ),
        ],
      );
      addTearDown(model.dispose);

      await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
      await tester.pumpAndSettle();

      expect(find.text('手机交接'), findsOneWidget);
      expect(find.textContaining('123456'), findsOneWidget);
      expect(find.bySemanticsLabel('手机配对二维码'), findsOneWidget);
      await tester.drag(find.byType(ListView).last, const Offset(0, -420));
      await tester.pumpAndSettle();
      expect(find.text('Test Phone'), findsOneWidget);
      await tester.drag(find.byType(ListView).last, const Offset(0, -700));
      await tester.pumpAndSettle();
      expect(find.text('meeting.wav'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

MeetingWorkspaceSnapshot _longWorkspace() {
  final segments = List<MeetingWorkspaceSegment>.generate(
    3001,
    (index) => MeetingWorkspaceSegment(
      id: index + 1,
      sequenceId: index,
      text: '片段 $index',
      startMs: index * 2000,
      endMs: index * 2000 + 1500,
      reviewState: index == 0
          ? MeetingWorkspaceReviewState.reviewed
          : MeetingWorkspaceReviewState.unreviewed,
      speakerState: MeetingWorkspaceSpeakerState.assigned,
      speakerId: 1,
      speakerName: '说话人 1',
      speakerSource: 'automatic',
    ),
    growable: false,
  );
  return MeetingWorkspaceSnapshot(
    summary: const MeetingWorkspaceSummary(
      recordingId: 1,
      displayName: '两小时会议',
      filePath: '/private/meeting.wav',
      durationMs: 2 * 60 * 60 * 1000,
      createdAtMs: 1,
      processingState: MeetingWorkspaceProcessingState.completed,
      generationId: 2,
      segmentCount: 3001,
    ),
    segments: segments,
    speakers: const <MeetingWorkspaceSpeaker>[
      MeetingWorkspaceSpeaker(
        id: 1,
        stableKey: 'speaker-1',
        displayName: '说话人 1',
        source: 'automatic',
        mergedIntoSpeakerId: null,
      ),
    ],
    insights: const <MeetingWorkspaceInsight>[],
    canUndo: true,
    canRedo: true,
  );
}

List<DesktopProcessingJob> _stateJobs() {
  const stages = <String>[
    'model_missing',
    'installing',
    'queued',
    'preparing',
    'asr',
    'diarization',
    'partial_success',
    'completed',
    'canceling',
    'canceled',
    'retryable_failure',
    'terminal_failure',
    'recovery_unknown',
  ];
  return List<DesktopProcessingJob>.generate(stages.length, (index) {
    final stage = stages[index];
    final state = switch (stage) {
      'completed' || 'partial_success' => DesktopJobState.completed,
      'canceled' => DesktopJobState.canceled,
      'retryable_failure' ||
      'terminal_failure' ||
      'recovery_unknown' => DesktopJobState.failed,
      'preparing' ||
      'asr' ||
      'diarization' ||
      'canceling' => DesktopJobState.processing,
      _ => DesktopJobState.pending,
    };
    return DesktopProcessingJob(
      id: index + 1,
      recordingId: index + 1,
      displayName: '任务 ${index + 1}',
      recordingPath: '/private/${index + 1}.wav',
      fingerprintSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      state: state,
      stage: stage,
      progress: index / stages.length,
      createdAtMs: index + 1,
    );
  }, growable: false);
}

class _WorkstationModel extends ChangeNotifier
    implements DesktopWorkstationModel {
  _WorkstationModel({
    this.section = DesktopWorkstationSection.library,
    this.selectedMeeting,
    this.jobs = const <DesktopProcessingJob>[],
    this.companionInvite,
    this.companionPeers = const <DesktopCompanionPeer>[],
    this.companionHistory = const <DesktopCompanionTransferHistory>[],
    this.engineAvailable = true,
    this.localProcessingSupported = true,
  }) : playback = DesktopMeetingPlaybackController(port: _PlaybackPort());

  @override
  DesktopWorkstationSection section;
  @override
  MeetingWorkspaceSnapshot? selectedMeeting;
  @override
  List<DesktopProcessingJob> jobs;
  @override
  final DesktopMeetingPlaybackController playback;
  @override
  final DesktopCaptureUiController captureController = _NoopCaptureController();

  @override
  bool get aiGenerating => false;
  @override
  String? get aiMessage => null;
  @override
  bool get aiSecretConfigured => false;
  @override
  DesktopAiProviderSettings get aiProviderSettings =>
      DesktopAiProviderSettings.deepSeek;
  @override
  bool get aiProviderProbing => false;
  @override
  bool get companionListening => true;
  @override
  int? get companionPort => 42424;
  @override
  String? get companionFingerprint => 'D'.padRight(32, 'D');
  @override
  String? get companionMessage => null;
  final DesktopCompanionPairingInvite? companionInvite;
  @override
  DesktopCompanionPairingInvite? get companionPairingInvite => companionInvite;
  @override
  final List<DesktopCompanionPeer> companionPeers;
  @override
  final List<DesktopCompanionTransferHistory> companionHistory;
  @override
  DesktopDiskEncryptionStatus get diskEncryptionStatus =>
      DesktopDiskEncryptionStatus.disabled;
  @override
  final bool engineAvailable;
  @override
  final bool localProcessingSupported;
  @override
  String get engineAvailabilityMessage => '已安装并验证';
  @override
  String? get errorMessage => null;
  @override
  bool get importing => false;
  @override
  bool get installingModels => false;
  @override
  bool get loading => false;
  @override
  List<MeetingWorkspaceSummary> get meetings =>
      const <MeetingWorkspaceSummary>[];
  @override
  double get modelInstallProgress => 1;
  @override
  ModelAssetInstallStatus get modelInstallStatus =>
      ModelAssetInstallStatus.installed;
  @override
  String? get noticeMessage => null;
  @override
  bool get processing =>
      jobs.any((job) => job.state == DesktopJobState.processing);
  @override
  String get searchQuery => '';
  @override
  List<MeetingWorkspaceSegment> get searchResults =>
      const <MeetingWorkspaceSegment>[];
  @override
  bool get workspaceLoading => false;

  @override
  Future<void> cancelProcessing() async {}
  @override
  Future<void> createCompanionPairingInvite() async {}
  @override
  Future<void> refreshCompanion() async {}
  @override
  Future<void> unpairCompanion(String deviceId) async {}
  @override
  void closeMeeting() {
    selectedMeeting = null;
    notifyListeners();
  }

  @override
  Future<void> deleteAiSecret() async {}
  @override
  Future<void> configureAiProvider(DesktopAiProviderSettings settings) async {}
  @override
  Future<void> probeAiProvider() async {}
  @override
  Future<String?> exportMeeting(MeetingWorkspaceExportFormat format) async =>
      null;
  @override
  Future<void> generateAiNotes({required bool consentGranted}) async {}
  @override
  Future<void> importMeeting() async {}
  @override
  Future<void> installModels() async {
    installModelCalls += 1;
  }

  int installModelCalls = 0;
  @override
  Future<void> load() async {
    notifyListeners();
  }

  @override
  Future<void> mergeSpeakers({
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) async {}
  @override
  Future<void> redoTranscript() async {}
  @override
  Future<void> renameSpeakers(Map<int, String> names) async {}
  @override
  Future<void> replaceAiSecret(String secret) async {}
  @override
  Future<void> retryJob(int jobId) async {}
  @override
  Future<void> reviewInsight({
    required int insightId,
    required String body,
    required bool publish,
  }) async {}
  @override
  Future<void> saveSegment({
    required int segmentId,
    required String text,
  }) async {}
  @override
  Future<void> searchTranscript(String query) async {}
  @override
  Future<void> selectMeeting(int recordingId) async {}
  @override
  void selectSection(DesktopWorkstationSection section) {
    this.section = section;
    notifyListeners();
  }

  @override
  Future<void> assignSpeaker({
    required int segmentId,
    required int? speakerId,
    required MeetingWorkspaceSpeakerState state,
  }) async {}
  @override
  Future<void> undoTranscript() async {}

  @override
  void dispose() {
    (captureController as _NoopCaptureController).dispose();
    playback.dispose();
    super.dispose();
  }
}

class _NoopCaptureController extends ChangeNotifier
    implements DesktopCaptureUiController {
  @override
  DesktopCaptureViewModel value = const DesktopCaptureViewModel();

  @override
  Future<void> discardRecovered(String sessionId) async {}
  @override
  Future<void> keepRecovered(String sessionId) async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> preflight({bool requestPermissions = false}) async {}
  @override
  void reset() {}
  @override
  Future<void> resume() async {}
  @override
  Future<void> restartCaptions() async {}
  @override
  void selectMicrophone(String deviceId) {}
  @override
  void setCaptionEnabled(bool enabled) {}
  @override
  Future<void> start() async {}
  @override
  Future<MeetingHandoffOutcome?> stop({String displayName = '电脑会议'}) async =>
      null;
}

class _PlaybackPort implements DesktopPlaybackPort {
  final StreamController<DesktopPlaybackSnapshot> _controller =
      StreamController<DesktopPlaybackSnapshot>.broadcast();

  @override
  Stream<DesktopPlaybackSnapshot> get snapshots => _controller.stream;
  @override
  Future<void> close() => _controller.close();
  @override
  Future<void> open(String path) async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> play() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setRate(double rate) async {}
}
