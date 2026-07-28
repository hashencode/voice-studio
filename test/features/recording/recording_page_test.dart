import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/controller/recording_controller.dart';
import 'package:voice2text_flutter/features/recording/engine/fake_recorder_engine.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/model/recording_annotation_entity.dart';
import 'package:voice2text_flutter/features/recording/recording_page.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_annotations_repository.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/recording/service/recording_recovery_coordinator.dart';
import 'package:voice2text_flutter/features/recording/services/microphone_permission_service.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/service/fake_transcription_service.dart';

void main() {
  testWidgets('first recording requires explicit local-processing consent', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final recorder = FakeRecorderEngine();
    final controller = _ConsentTestRecordingController(recorder: recorder);
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: RecordingPage(
          controller: controller,
          recordingAnnotationsRepository:
              _MemoryRecordingAnnotationsRepository(),
          initializeController: false,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byIcon(Icons.mic_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('开始会议录音'), findsOneWidget);
    expect(find.textContaining('只在本机处理'), findsOneWidget);
    expect(find.text('已获得同意'), findsOneWidget);
    expect((await recorder.getState()).state, 'idle');

    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('开始会议录音'), findsNothing);
    expect((await recorder.getState()).state, 'idle');
  });

  testWidgets('recording displays the real input route and paused state', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final recorder = FakeRecorderEngine()
      ..inputAmplitude = RecordingSessionSnapshot.maxInputAmplitude
      ..inputStatus = RecordingInputStatus.available
      ..inputDeviceType = RecordingInputDeviceType.bluetooth;
    final sessions = _NoopRecordingSessionsRepository();
    final settings = _ConsentedAppSettingsRepository();
    final controller = RecordingController(
      permissionService: _GrantedPermissionService(),
      recorder: recorder,
      recordingSessionsRepository: sessions,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      ),
      transcriptionJobsRepository: TranscriptionJobsRepository(),
      transcriptionService: FakeTranscriptionService(),
      appSettingsRepository: settings,
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: RecordingPage(
          controller: controller,
          recordingAnnotationsRepository:
              _MemoryRecordingAnnotationsRepository(),
          initializeController: false,
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('蓝牙麦克风 · 输入正常'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.pause_rounded));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('录音已暂停'), findsOneWidget);
  });

  testWidgets('input device panel selects a connected microphone', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final recorder = FakeRecorderEngine()
      ..inputDevices = const <RecordingInputDevice>[
        RecordingInputDevice(
          id: 1,
          name: '手机麦克风',
          type: RecordingInputDeviceType.builtIn,
          canSelect: true,
        ),
        RecordingInputDevice(
          id: 42,
          name: '会议耳机',
          type: RecordingInputDeviceType.bluetooth,
          canSelect: true,
        ),
      ];
    final controller = _ConsentTestRecordingController(recorder: recorder);
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: GooToastScope(
          child: RecordingPage(
            controller: controller,
            recordingAnnotationsRepository:
                _MemoryRecordingAnnotationsRepository(),
            initializeController: false,
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.textContaining('输入设备'));
    await tester.pumpAndSettle();
    expect(find.text('系统自动选择'), findsOneWidget);
    expect(find.text('会议耳机'), findsOneWidget);

    await tester.tap(find.text('会议耳机'));
    await tester.pumpAndSettle();

    expect(recorder.preferredInputDeviceId, 42);
    expect(find.textContaining('输入设备：会议耳机'), findsOneWidget);
  });

  testWidgets(
    'markers and note are saved through the active session repository',
    (WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final recorder = FakeRecorderEngine();
      final sessions = _NoopRecordingSessionsRepository();
      final annotations = _MemoryRecordingAnnotationsRepository();
      final controller = RecordingController(
        permissionService: _GrantedPermissionService(),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: _ConsentedAppSettingsRepository(),
      );
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: GooToastScope(
            child: RecordingPage(
              controller: controller,
              recordingAnnotationsRepository: annotations,
              initializeController: false,
            ),
          ),
        ),
      );

      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.byIcon(Icons.flag_outlined));
      await tester.pump();
      expect(find.textContaining('标记数 1'), findsOneWidget);

      await tester.tap(find.text('备注'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.enterText(find.byType(EditableText), '跟进客户报价');
      final saveButton = tester.widget<GooButton>(
        find.ancestor(of: find.text('保存备注'), matching: find.byType(GooButton)),
      );
      saveButton.onPressed!();
      await tester.pump(const Duration(milliseconds: 300));

      final sessionId = controller.activeSessionId!;
      final saved = await annotations.listForSession(sessionId);
      expect(saved, hasLength(2));
      expect(
        saved
            .singleWhere((item) => item.kind == RecordingAnnotationKind.note)
            .text,
        '跟进客户报价',
      );

      await tester.tap(find.byIcon(Icons.stop_rounded));
      await tester.pump(const Duration(milliseconds: 100));
      expect(await annotations.listForSession(sessionId), hasLength(2));
    },
  );
}

class _GrantedPermissionService extends MicrophonePermissionService {
  @override
  Future<bool> ensurePermissionGranted() async => true;
}

class _NoopRecordingSessionsRepository extends RecordingSessionsRepository {
  @override
  Future<void> upsertSnapshot(RecordingSessionSnapshot snapshot) async {}

  @override
  Future<int> commitCompleted(
    RecorderResult result, {
    bool enqueueTranscription = false,
  }) async => 1;
}

class _ConsentedAppSettingsRepository extends AppSettingsRepository {
  final AppSettings _settings = AppSettings.defaults().copyWith(
    recordingConsentVersion: 1,
    recordingConsentAcceptedAtMs: 1,
  );

  @override
  Future<AppSettings> load() async => _settings;

  @override
  Future<bool> hasCurrentRecordingConsent(int requiredVersion) async => true;
}

class _MemoryRecordingAnnotationsRepository
    extends RecordingAnnotationsRepository {
  final List<RecordingAnnotationEntity> _items = <RecordingAnnotationEntity>[];
  int _nextId = 1;

  @override
  Future<List<RecordingAnnotationEntity>> listForSession(
    String sessionId,
  ) async {
    return _items
        .where((item) => item.sessionId == sessionId)
        .toList(growable: false);
  }

  @override
  Future<RecordingAnnotationEntity> addMarker({
    required String sessionId,
    required int positionMs,
  }) async {
    final item = RecordingAnnotationEntity(
      id: _nextId++,
      sessionId: sessionId,
      kind: RecordingAnnotationKind.marker,
      positionMs: positionMs,
      createdAtMs: 1,
      updatedAtMs: 1,
    );
    _items.add(item);
    return item;
  }

  @override
  Future<RecordingAnnotationEntity?> saveNote({
    required String sessionId,
    required int positionMs,
    required String text,
  }) async {
    _items.removeWhere(
      (item) =>
          item.sessionId == sessionId &&
          item.kind == RecordingAnnotationKind.note,
    );
    final normalized = text.trim();
    if (normalized.isEmpty) return null;
    final item = RecordingAnnotationEntity(
      id: _nextId++,
      sessionId: sessionId,
      kind: RecordingAnnotationKind.note,
      positionMs: positionMs,
      text: normalized,
      createdAtMs: 1,
      updatedAtMs: 1,
    );
    _items.add(item);
    return item;
  }
}

class _ConsentTestRecordingController extends RecordingController {
  _ConsentTestRecordingController({required FakeRecorderEngine recorder})
    : super(
        permissionService: _GrantedPermissionService(),
        recorder: recorder,
        recordingSessionsRepository: RecordingSessionsRepository(),
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: RecordingSessionsRepository(),
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(),
      );

  @override
  Future<void> initialize() async {}

  @override
  Future<bool> hasCurrentRecordingConsent({int requiredVersion = 1}) async =>
      false;

  @override
  Future<void> acceptRecordingConsent({int version = 1}) async {}
}
