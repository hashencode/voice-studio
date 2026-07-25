import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/recording/controller/recording_controller.dart';
import 'package:voice2text_flutter/features/recording/engine/fake_recorder_engine.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/model/recording_phase.dart';
import 'package:voice2text_flutter/features/recording/repository/recording_sessions_repository.dart';
import 'package:voice2text_flutter/features/recording/service/recording_recovery_coordinator.dart';
import 'package:voice2text_flutter/features/recording/services/microphone_permission_service.dart';
import 'package:voice2text_flutter/features/settings/model/app_settings.dart';
import 'package:voice2text_flutter/features/settings/repository/app_settings_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_result.dart';
import 'package:voice2text_flutter/features/transcription/service/fake_transcription_service.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_job_reconciler.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_port.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_queue_coordinator.dart';

import 'recording_test_database.dart';

void main() {
  test(
    'stop commits and returns while queued recognition is still running',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recorder = FakeRecorderEngine();
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final settings = AppSettingsRepository(database: fixture.appDatabase);
      await settings.save(
        AppSettings(
          modelId: AppSettings.supportedModelId,
          autoTranscribe: true,
          isDarkMode: false,
        ),
      );
      final jobs = TranscriptionJobsRepository(database: fixture.appDatabase);
      final port = _BlockingTranscriptionPort();
      final queue = TranscriptionQueueCoordinator(
        repository: jobs,
        transcriptionPort: port,
        settingsRepository: settings,
        reconciler: TranscriptionJobReconciler(repository: jobs),
      );
      await queue.start();
      addTearDown(queue.dispose);
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: jobs,
        transcriptionService: port,
        transcriptionQueueCoordinator: queue,
        appSettingsRepository: settings,
      );
      addTearDown(controller.dispose);

      await controller.initialize();
      await controller.start();
      final firstSessionId = controller.activeSessionId;
      expect(await controller.stop(), isTrue);
      expect(controller.phase, RecordingPhase.idle);
      await _eventually(() => port.started);

      final queued = (await jobs.listRecent()).single;
      expect(queued.status, 'processing');
      expect(port.completed, isFalse);

      await controller.start();
      expect(controller.phase, RecordingPhase.recording);
      expect(controller.activeSessionId, isNot(firstSessionId));

      port.complete('后台转写完成');
      await queue.waitUntilIdle();
      expect((await jobs.findById(queued.id))?.status, 'completed');
      expect(controller.phase, RecordingPhase.recording);

      expect(await controller.stop(), isTrue);
      await queue.waitUntilIdle();
      expect(await jobs.listRecent(), hasLength(2));
      expect(await fixture.database.query('recordings'), hasLength(2));
    },
  );

  test('recording state survives lifecycle pause and completes once', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recorder = FakeRecorderEngine();
    final sessions = RecordingSessionsRepository(database: fixture.appDatabase);
    final settings = AppSettingsRepository(database: fixture.appDatabase);
    await settings.save(
      AppSettings(
        modelId: AppSettings.supportedModelId,
        autoTranscribe: false,
        isDarkMode: false,
      ),
    );
    final controller = RecordingController(
      permissionService: _FixedPermissionService(granted: true),
      recorder: recorder,
      recordingSessionsRepository: sessions,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      ),
      transcriptionJobsRepository: TranscriptionJobsRepository(
        database: fixture.appDatabase,
      ),
      transcriptionService: FakeTranscriptionService(),
      appSettingsRepository: settings,
    );
    addTearDown(controller.dispose);

    await controller.initialize();
    await controller.start();
    final String? sessionId = controller.activeSessionId;
    expect(controller.phase, RecordingPhase.recording);
    expect(sessionId, isNotEmpty);

    expect(
      await controller.handleLifecycleInterruption(),
      InterruptionResult.continuesInBackground,
    );
    expect(controller.phase, RecordingPhase.recording);

    await controller.pause();
    expect(controller.phase, RecordingPhase.paused);
    await controller.resume();
    expect(controller.phase, RecordingPhase.recording);
    expect(controller.activeSessionId, sessionId);

    expect(await controller.stop(), isTrue);
    expect(controller.phase, RecordingPhase.idle);
    expect(controller.activeSessionId, isNull);
    expect(await controller.stop(), isFalse);
    expect(await fixture.database.query('recordings'), hasLength(1));
    expect(await fixture.database.query('recording_sessions'), hasLength(1));
  });

  test('denied microphone permission leaves an actionable error', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recorder = FakeRecorderEngine();
    final sessions = RecordingSessionsRepository(database: fixture.appDatabase);
    final controller = RecordingController(
      permissionService: _FixedPermissionService(granted: false),
      recorder: recorder,
      recordingSessionsRepository: sessions,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      ),
      transcriptionJobsRepository: TranscriptionJobsRepository(
        database: fixture.appDatabase,
      ),
      transcriptionService: FakeTranscriptionService(),
      appSettingsRepository: AppSettingsRepository(
        database: fixture.appDatabase,
      ),
    );
    addTearDown(controller.dispose);

    await controller.start();

    expect(controller.phase, RecordingPhase.error);
    expect(controller.permissionDenied, isTrue);
    expect(controller.errorMessage, contains('麦克风权限'));
    expect((await recorder.getState()).state, 'idle');
  });

  test('recording consent is versioned and persisted', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recorder = FakeRecorderEngine();
    final sessions = RecordingSessionsRepository(database: fixture.appDatabase);
    final controller = RecordingController(
      permissionService: _FixedPermissionService(granted: true),
      recorder: recorder,
      recordingSessionsRepository: sessions,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      ),
      transcriptionJobsRepository: TranscriptionJobsRepository(
        database: fixture.appDatabase,
      ),
      transcriptionService: FakeTranscriptionService(),
      appSettingsRepository: AppSettingsRepository(
        database: fixture.appDatabase,
      ),
    );
    addTearDown(controller.dispose);

    expect(await controller.hasCurrentRecordingConsent(), isFalse);
    await controller.acceptRecordingConsent();
    expect(await controller.hasCurrentRecordingConsent(), isTrue);
    expect(
      await controller.hasCurrentRecordingConsent(requiredVersion: 2),
      isFalse,
    );
  });

  test(
    'completed native session is committed and idle timer is reset',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recorder = _CompletedRecorder();
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
      );
      addTearDown(controller.dispose);

      await controller.initialize();

      expect(controller.phase, RecordingPhase.idle);
      expect(controller.elapsedMs, 0);
      expect(controller.activeSessionId, isNull);
      final session = await sessions.findBySessionId('completed-session');
      expect(session?.state, 'completed');
      expect(session?.recordingId, isNotNull);
    },
  );

  test('recording telemetry is sampled and stops while paused', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final recorder = FakeRecorderEngine()
      ..inputAmplitude = RecordingSessionSnapshot.maxInputAmplitude
      ..inputStatus = RecordingInputStatus.available
      ..inputDeviceType = RecordingInputDeviceType.bluetooth;
    final sessions = RecordingSessionsRepository(database: fixture.appDatabase);
    final controller = RecordingController(
      permissionService: _FixedPermissionService(granted: true),
      recorder: recorder,
      recordingSessionsRepository: sessions,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: sessions,
      ),
      transcriptionJobsRepository: TranscriptionJobsRepository(
        database: fixture.appDatabase,
      ),
      transcriptionService: FakeTranscriptionService(),
      appSettingsRepository: AppSettingsRepository(
        database: fixture.appDatabase,
      ),
    );
    addTearDown(controller.dispose);

    await controller.initialize();
    await controller.start();
    await Future<void>.delayed(const Duration(milliseconds: 240));

    expect(controller.inputStatus, RecordingInputStatus.available);
    expect(controller.inputDeviceType, RecordingInputDeviceType.bluetooth);
    expect(controller.inputAmplitudeWindow.last, 1);
    final callsBeforePause = recorder.getStateCallCount;

    await controller.pause();
    final callsAfterPause = recorder.getStateCallCount;
    await Future<void>.delayed(const Duration(milliseconds: 400));

    expect(controller.inputStatus, RecordingInputStatus.paused);
    expect(callsAfterPause, greaterThanOrEqualTo(callsBeforePause + 1));
    expect(recorder.getStateCallCount, callsAfterPause);
  });

  test(
    'telemetry failures degrade to unknown without stopping recording',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recorder = _FailingTelemetryRecorder();
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
      );
      addTearDown(controller.dispose);

      await controller.initialize();
      await controller.start();
      recorder.failTelemetry = true;
      await Future<void>.delayed(const Duration(milliseconds: 240));

      expect(controller.phase, RecordingPhase.recording);
      expect(controller.errorMessage, isNull);
      expect(controller.inputStatus, RecordingInputStatus.unknown);
      expect(controller.inputDeviceType, RecordingInputDeviceType.unknown);
      expect(await controller.stop(), isTrue);
    },
  );

  test(
    'input selection is retained before start and disconnect is surfaced',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
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
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
      );
      addTearDown(controller.dispose);

      await controller.refreshInputDevices();
      expect(controller.inputDevices, hasLength(2));
      expect(controller.inputSelectionSupported, isTrue);

      expect(await controller.selectInputDevice(42), isTrue);
      expect(controller.preferredInputDeviceId, 42);
      expect(recorder.preferredInputDeviceId, 42);

      await controller.start();
      recorder.simulatePreferredInputDisconnect();
      await Future<void>.delayed(const Duration(milliseconds: 240));

      expect(controller.phase, RecordingPhase.recording);
      expect(controller.preferredInputDeviceId, isNull);
      expect(controller.inputRouteNotice, contains('已切换到系统默认输入'));

      expect(await controller.stop(), isTrue);
      await controller.start();

      expect(controller.inputRouteNotice, isNull);
    },
  );

  test(
    'failed disconnect fallback stops, saves, and reattaches once',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
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
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
      );
      addTearDown(controller.dispose);

      await controller.selectInputDevice(42);
      await controller.start();
      final sessionId = controller.activeSessionId;
      recorder.simulatePreferredInputDisconnect(fallbackSucceeded: false);
      await Future<void>.delayed(const Duration(milliseconds: 240));

      expect(controller.phase, RecordingPhase.idle);
      expect(controller.inputRouteNotice, contains('录音已停止并保存'));
      expect((await sessions.findBySessionId(sessionId!))?.state, 'completed');
      expect(await fixture.database.query('recordings'), hasLength(1));
    },
  );

  test(
    'preferred input disconnected before start falls back to automatic input',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
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
      final sessions = RecordingSessionsRepository(
        database: fixture.appDatabase,
      );
      final controller = RecordingController(
        permissionService: _FixedPermissionService(granted: true),
        recorder: recorder,
        recordingSessionsRepository: sessions,
        recoveryCoordinator: RecordingRecoveryCoordinator(
          recorder: recorder,
          sessionsRepository: sessions,
        ),
        transcriptionJobsRepository: TranscriptionJobsRepository(
          database: fixture.appDatabase,
        ),
        transcriptionService: FakeTranscriptionService(),
        appSettingsRepository: AppSettingsRepository(
          database: fixture.appDatabase,
        ),
      );
      addTearDown(controller.dispose);

      expect(await controller.selectInputDevice(42), isTrue);
      recorder.inputDevices = const <RecordingInputDevice>[
        RecordingInputDevice(
          id: 1,
          name: '手机麦克风',
          type: RecordingInputDeviceType.builtIn,
          canSelect: true,
        ),
      ];

      await controller.start();

      expect(controller.phase, RecordingPhase.recording);
      expect(controller.preferredInputDeviceId, isNull);
      expect(controller.inputRouteNotice, contains('已切换到系统默认输入'));
    },
  );
}

class _BlockingTranscriptionPort implements TranscriptionPort {
  final Completer<TranscriptionResult> _completer =
      Completer<TranscriptionResult>();
  bool started = false;

  bool get completed => _completer.isCompleted;

  @override
  Stream<TranscriptionProgressEvent> get progressEvents =>
      const Stream<TranscriptionProgressEvent>.empty();

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) {
    started = true;
    return _completer.future;
  }

  @override
  Future<void> cancel(int jobId) async {
    if (!_completer.isCompleted) {
      _completer.completeError(const TranscriptionCanceledException());
    }
  }

  @override
  Future<Set<int>> activeJobIds() async => const <int>{};

  void complete(String text) => _completer.complete(
    TranscriptionResult.singleText(text, durationMs: 1000),
  );
}

Future<void> _eventually(bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition was not reached');
}

class _FixedPermissionService extends MicrophonePermissionService {
  _FixedPermissionService({required this.granted});

  final bool granted;

  @override
  Future<bool> ensurePermissionGranted() async => granted;
}

class _CompletedRecorder implements RecorderPort {
  static const snapshot = RecordingSessionSnapshot(
    sessionId: 'completed-session',
    state: 'completed',
    durationMs: 42_000,
    canonicalPath: '/recordings/completed-session.m4a',
    stopReason: 'notification_stop',
  );

  @override
  Future<RecordingSessionSnapshot> getState() async => snapshot;

  @override
  Future<List<RecordingInputDevice>> listInputDevices() async =>
      const <RecordingInputDevice>[];

  @override
  Future<RecordingSessionSnapshot> selectInputDevice(int? deviceId) async =>
      snapshot;

  @override
  Future<List<RecordingRecoveryCandidate>> listRecoveries() async =>
      const <RecordingRecoveryCandidate>[];

  @override
  Future<void> discardRecovery(String sessionId) => throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> pause() => throw UnimplementedError();

  @override
  Future<RecorderResult> recover(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> resume() => throw UnimplementedError();

  @override
  Future<RecordingSessionSnapshot> start({String? sessionId}) =>
      throw UnimplementedError();

  @override
  Future<RecorderResult> stop({String reason = 'user_stop'}) =>
      throw UnimplementedError();
}

class _FailingTelemetryRecorder extends FakeRecorderEngine {
  bool failTelemetry = false;

  @override
  Future<RecordingSessionSnapshot> getState() {
    if (failTelemetry) {
      throw RecorderException('telemetry unavailable', code: 'TELEMETRY');
    }
    return super.getState();
  }
}
