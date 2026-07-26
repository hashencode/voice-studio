import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show FrameTiming;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:media_kit/media_kit.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/app/desktop_app.dart';
import 'package:voice2text_desktop/app/desktop_workstation_model.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_repository.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_service.dart';
import 'package:voice2text_desktop/features/meetings/playback/desktop_meeting_playback.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';
import 'package:voice2text_desktop/features/security/desktop_disk_encryption.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('macOS workstation is keyboard reachable at 200% dark mode', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 1050));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(() {
      tester.binding.setSurfaceSize(null);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      tester.platformDispatcher.clearPlatformBrightnessTestValue();
    });
    final model = _MacosRegressionModel(
      section: DesktopWorkstationSection.settings,
    );
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('工作站主导航'), findsOneWidget);
    expect(find.text('固定处理引擎'), findsOneWidget);
    expect(find.text('FileVault 磁盘加密未启用'), findsOneWidget);
    expect(find.textContaining('没有应用层整库加密'), findsOneWidget);
    expect(
      Theme.of(tester.element(find.text('设置').last)).brightness,
      Brightness.dark,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    expect(FocusManager.instance.primaryFocus, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('3001-segment fixed scroll keeps long frames below 1%', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 1050));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final model = _MacosRegressionModel(selectedMeeting: _longWorkspace());
    addTearDown(model.dispose);

    await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('transcript_virtual_list')),
      findsOneWidget,
    );

    // Warm the exact path before the fixed measured script.
    await tester.timedDrag(
      find.byKey(const ValueKey('transcript_virtual_list')),
      const Offset(0, -900),
      const Duration(seconds: 1),
    );
    await tester.pumpAndSettle();

    final timings = <FrameTiming>[];
    void collect(List<FrameTiming> values) => timings.addAll(values);
    binding.addTimingsCallback(collect);
    await tester.timedDrag(
      find.byKey(const ValueKey('transcript_virtual_list')),
      const Offset(0, -9000),
      const Duration(seconds: 10),
    );
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 250));
    binding.removeTimingsCallback(collect);

    expect(timings, isNotEmpty);
    const frameBudgetMicros = 16667;
    final longFrames = timings
        .where((timing) => timing.totalSpan.inMicroseconds > frameBudgetMicros)
        .length;
    final longFrameRate = longFrames / timings.length;
    final longListEvidence = jsonEncode(<String, Object>{
      'segmentCount': 3001,
      'frameCount': timings.length,
      'longFrameCount': longFrames,
      'longFrameRate': longFrameRate,
      'frameBudgetMicros': frameBudgetMicros,
    });
    debugPrint('U9_LONG_LIST_EVIDENCE=$longListEvidence');
    expect(longFrameRate, lessThan(0.01));
    expect(tester.takeException(), isNull);
  });

  testWidgets('real media_kit playback seek P95 stays below 200ms', (
    tester,
  ) async {
    MediaKit.ensureInitialized();
    final audio = await _createPcmWav();
    addTearDown(() async {
      if (await audio.exists()) await audio.delete();
    });
    final port = MediaKitDesktopPlaybackPort();
    addTearDown(port.close);
    await port.open(audio.path);

    await port.seek(const Duration(milliseconds: 100));
    final samples = <int>[];
    for (var index = 0; index < 20; index++) {
      final stopwatch = Stopwatch()..start();
      await port.seek(Duration(milliseconds: 100 + (index % 10) * 100));
      stopwatch.stop();
      samples.add(stopwatch.elapsedMicroseconds);
    }
    samples.sort();
    final p95Micros = samples[18];
    final playbackEvidence = jsonEncode(<String, Object>{
      'sampleCount': samples.length,
      'p95Micros': p95Micros,
      'maxMicros': samples.last,
      'fixturePath': audio.path,
    });
    debugPrint('U9_PLAYBACK_SEEK_EVIDENCE=$playbackEvidence');
    expect(p95Micros, lessThan(200000));
  });
}

Future<File> _createPcmWav() async {
  const sampleRate = 16000;
  const seconds = 30;
  const sampleCount = sampleRate * seconds;
  final bytes = ByteData(44 + sampleCount * 2);

  void ascii(int offset, String value) {
    for (var index = 0; index < value.length; index++) {
      bytes.setUint8(offset + index, value.codeUnitAt(index));
    }
  }

  ascii(0, 'RIFF');
  bytes.setUint32(4, 36 + sampleCount * 2, Endian.little);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  bytes.setUint32(16, 16, Endian.little);
  bytes.setUint16(20, 1, Endian.little);
  bytes.setUint16(22, 1, Endian.little);
  bytes.setUint32(24, sampleRate, Endian.little);
  bytes.setUint32(28, sampleRate * 2, Endian.little);
  bytes.setUint16(32, 2, Endian.little);
  bytes.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  bytes.setUint32(40, sampleCount * 2, Endian.little);
  for (var index = 0; index < sampleCount; index++) {
    final sample = (math.sin(2 * math.pi * 220 * index / sampleRate) * 2400)
        .round();
    bytes.setInt16(44 + index * 2, sample, Endian.little);
  }

  final file = File(
    '${Directory.systemTemp.path}/voice2text-u9-playback-${DateTime.now().microsecondsSinceEpoch}.wav',
  );
  await file.writeAsBytes(bytes.buffer.asUint8List(), flush: true);
  return file;
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

class _MacosRegressionModel extends ChangeNotifier
    implements DesktopWorkstationModel {
  _MacosRegressionModel({
    this.section = DesktopWorkstationSection.library,
    this.selectedMeeting,
  }) : playback = DesktopMeetingPlaybackController(port: _PlaybackPort());

  @override
  DesktopWorkstationSection section;
  @override
  MeetingWorkspaceSnapshot? selectedMeeting;
  @override
  final DesktopMeetingPlaybackController playback;

  @override
  bool get aiGenerating => false;
  @override
  String? get aiMessage => null;
  @override
  bool get aiSecretConfigured => false;
  @override
  bool get companionListening => true;
  @override
  int? get companionPort => 42424;
  @override
  String? get companionFingerprint => 'D'.padRight(32, 'D');
  @override
  String? get companionMessage => null;
  @override
  DesktopCompanionPairingInvite? get companionPairingInvite => null;
  @override
  List<DesktopCompanionPeer> get companionPeers =>
      const <DesktopCompanionPeer>[];
  @override
  List<DesktopCompanionTransferHistory> get companionHistory =>
      const <DesktopCompanionTransferHistory>[];
  @override
  DesktopDiskEncryptionStatus get diskEncryptionStatus =>
      DesktopDiskEncryptionStatus.disabled;
  @override
  bool get engineAvailable => true;
  @override
  String get engineAvailabilityMessage => '已安装并验证';
  @override
  String? get errorMessage => null;
  @override
  bool get importing => false;
  @override
  bool get installingModels => false;
  @override
  List<DesktopProcessingJob> get jobs => const <DesktopProcessingJob>[];
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
  bool get processing => false;
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
  Future<String?> exportMeeting(MeetingWorkspaceExportFormat format) async =>
      null;
  @override
  Future<void> generateAiNotes({required bool consentGranted}) async {}
  @override
  Future<void> importMeeting() async {}
  @override
  Future<void> installModels() async {}
  @override
  Future<void> load() async => notifyListeners();
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
    playback.dispose();
    super.dispose();
  }
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
