import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:permission_handler/permission_handler.dart';

import '../settings/repository/app_settings_repository.dart';
import '../transcription/repository/transcription_jobs_repository.dart';
import '../transcription/service/transcription_port.dart';
import '../transcription/service/transcription_job_reconciler.dart';
import '../transcription/service/transcription_queue_coordinator.dart';
import 'controller/recording_controller.dart';
import 'engine/recorder_port.dart';
import 'model/recording_annotation_entity.dart';
import 'model/recording_phase.dart';
import 'repository/recording_annotations_repository.dart';
import 'repository/recording_sessions_repository.dart';
import 'service/recording_recovery_coordinator.dart';
import 'services/microphone_permission_service.dart';
import 'widgets/recording_recovery_panel.dart';

const List<String> _rulerLabels = <String>['00:02', '00:04', '00:06', '00:08'];
const int _rulerTickCount = 22;
const int _waveSegmentCount = 72;
const int _waveCenterIndex = _waveSegmentCount ~/ 2;
const String _automaticInputSelection = 'automatic';
const List<FontFeature> _tabular = <FontFeature>[FontFeature.tabularFigures()];

class RecordingPage extends StatefulWidget {
  const RecordingPage({
    super.key,
    this.controller,
    this.recorder,
    this.transcriptionPort,
    this.transcriptionQueueCoordinator,
    this.recordingAnnotationsRepository,
    this.initializeController = true,
    this.notificationPermissionEnabled = false,
  });

  final RecordingController? controller;
  final RecorderPort? recorder;
  final TranscriptionPort? transcriptionPort;
  final TranscriptionQueueCoordinator? transcriptionQueueCoordinator;
  final RecordingAnnotationsRepository? recordingAnnotationsRepository;
  final bool initializeController;
  final bool notificationPermissionEnabled;

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage>
    with WidgetsBindingObserver {
  late final RecordingController _controller;
  late final bool _ownsController;
  late final RecordingAnnotationsRepository _recordingAnnotationsRepository;
  TranscriptionQueueCoordinator? _ownedTranscriptionQueueCoordinator;
  bool _interruptionHandling = false;
  bool _showNotificationPermissionWarning = false;
  bool _recoveryPanelOpen = false;
  bool _inputDevicePanelOpen = false;
  String? _pendingInterruptionNotice;
  String _displayName = '未命名录音';
  String _remarkText = '';
  final List<int> _markerTimestamps = <int>[];
  String? _annotationSessionId;
  int _annotationLoadEpoch = 0;
  bool _annotationsLoading = false;
  bool _annotationSaving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _ownsController = widget.controller == null;
    _controller = widget.controller ?? _buildController();
    _recordingAnnotationsRepository =
        widget.recordingAnnotationsRepository ??
        RecordingAnnotationsRepository();
    _controller.addListener(_onControllerChanged);
    _syncAnnotationsForSession(_controller.activeSessionId);
    if (widget.initializeController) {
      _initialize();
    }
  }

  RecordingController _buildController() {
    final RecorderPort recorder =
        widget.recorder ??
        (throw StateError(
          'RecordingPage requires an injected recorder outside tests.',
        ));
    final RecordingSessionsRepository recordingSessionsRepository =
        RecordingSessionsRepository();
    final TranscriptionJobsRepository jobsRepository =
        TranscriptionJobsRepository();
    final AppSettingsRepository settingsRepository = AppSettingsRepository();
    final TranscriptionPort transcriptionPort =
        widget.transcriptionPort ??
        (throw StateError(
          'RecordingPage requires an injected transcription port.',
        ));
    final TranscriptionQueueCoordinator queueCoordinator =
        widget.transcriptionQueueCoordinator ??
        TranscriptionQueueCoordinator(
          repository: jobsRepository,
          transcriptionPort: transcriptionPort,
          settingsRepository: settingsRepository,
          reconciler: TranscriptionJobReconciler(repository: jobsRepository),
        );
    if (widget.transcriptionQueueCoordinator == null) {
      _ownedTranscriptionQueueCoordinator = queueCoordinator;
      unawaited(queueCoordinator.start());
    }
    return RecordingController(
      permissionService: MicrophonePermissionService(),
      recorder: recorder,
      recordingSessionsRepository: recordingSessionsRepository,
      recoveryCoordinator: RecordingRecoveryCoordinator(
        recorder: recorder,
        sessionsRepository: recordingSessionsRepository,
      ),
      transcriptionJobsRepository: jobsRepository,
      transcriptionService: transcriptionPort,
      appSettingsRepository: settingsRepository,
      transcriptionQueueCoordinator: queueCoordinator,
    );
  }

  Future<void> _initialize() async {
    await _controller.initialize();
    if (!mounted) return;
    await _showRecoveryPanelIfNeeded();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.removeListener(_onControllerChanged);
    if (_ownsController) {
      _controller.dispose();
    }
    final ownedQueue = _ownedTranscriptionQueueCoordinator;
    if (ownedQueue != null) {
      unawaited(ownedQueue.dispose());
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _handleInterruption();
      return;
    }
    if (state == AppLifecycleState.resumed) {
      _reattachAfterResume();
      _flushPendingInterruptionNotice();
    }
  }

  Future<void> _reattachAfterResume() async {
    await _controller.reattach();
    if (!mounted) return;
    await _controller.refreshRecoveries();
    if (!mounted) return;
    await _showRecoveryPanelIfNeeded();
  }

  void _onControllerChanged() {
    if (!mounted) return;
    _syncAnnotationsForSession(_controller.activeSessionId);
    setState(() {});
  }

  void _syncAnnotationsForSession(String? sessionId) {
    if (_annotationSessionId == sessionId) return;
    _annotationSessionId = sessionId;
    final int loadEpoch = ++_annotationLoadEpoch;
    if (sessionId == null) {
      _annotationsLoading = false;
      _remarkText = '';
      _markerTimestamps.clear();
      return;
    }
    _annotationsLoading = true;
    unawaited(_loadAnnotations(sessionId, loadEpoch));
  }

  Future<void> _loadAnnotations(String sessionId, int loadEpoch) async {
    try {
      final annotations = await _recordingAnnotationsRepository.listForSession(
        sessionId,
      );
      if (!mounted ||
          loadEpoch != _annotationLoadEpoch ||
          _annotationSessionId != sessionId) {
        return;
      }
      setState(() {
        _annotationsLoading = false;
        _markerTimestamps
          ..clear()
          ..addAll(
            annotations
                .where((item) => item.kind == RecordingAnnotationKind.marker)
                .map((item) => item.positionMs),
          );
        _remarkText =
            annotations
                .where((item) => item.kind == RecordingAnnotationKind.note)
                .firstOrNull
                ?.text ??
            '';
      });
    } catch (_) {
      if (!mounted ||
          loadEpoch != _annotationLoadEpoch ||
          _annotationSessionId != sessionId) {
        return;
      }
      setState(() => _annotationsLoading = false);
      GooToastScope.of(context).error('无法读取本次录音的标记和备注');
    }
  }

  Future<void> _handleInterruption() async {
    if (_interruptionHandling) return;
    _interruptionHandling = true;

    final InterruptionResult result = await _controller
        .handleLifecycleInterruption();
    if (!mounted) {
      _interruptionHandling = false;
      return;
    }

    if (result == InterruptionResult.continuesInBackground) {
      _pendingInterruptionNotice = '录音将在后台继续，通知栏可随时停止并保存';
    }

    _flushPendingInterruptionNotice();
    _interruptionHandling = false;
  }

  void _flushPendingInterruptionNotice() {
    final String? message = _pendingInterruptionNotice;
    if (message == null || !mounted) return;
    final AppLifecycleState? lifecycle = WidgetsBinding.instance.lifecycleState;
    if (lifecycle != AppLifecycleState.resumed) return;

    _pendingInterruptionNotice = null;
    GooToastScope.of(
      context,
    ).show(message: message, variant: GooToastVariant.info);
  }

  Future<void> _openRemarkSheet() async {
    final String? sessionId = _controller.activeSessionId;
    if (sessionId == null ||
        !_controller.canStop ||
        _annotationsLoading ||
        _annotationSaving) {
      return;
    }
    final TextEditingController textController = TextEditingController(
      text: _remarkText,
    );
    final bool? saved = await showGooPanel<bool>(
      context: context,
      title: '灵感速记',
      useRootNavigator: true,
      builder:
          (
            BuildContext _,
            GooPanelController<bool> panelController,
            ScrollController scrollController,
          ) {
            return ListView(
              controller: scrollController,
              padding: EdgeInsets.zero,
              children: <Widget>[
                GooTextArea(
                  controller: textController,
                  label: '备注',
                  placeholder: '输入灵感速记',
                  minHeight: 176,
                  maxHeight: 280,
                  autoGrow: true,
                  showClearButton: true,
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: GooButton(
                    onPressed: () => panelController.closeWithResult(true),
                    child: const Text('保存备注'),
                  ),
                ),
              ],
            );
          },
    );
    if (saved == true && mounted) {
      _annotationLoadEpoch += 1;
      setState(() => _annotationSaving = true);
      try {
        final note = await _recordingAnnotationsRepository.saveNote(
          sessionId: sessionId,
          positionMs: _controller.elapsedMs,
          text: textController.text,
        );
        if (mounted && _annotationSessionId == sessionId) {
          setState(() {
            _remarkText = note?.text ?? '';
          });
          GooToastScope.of(
            context,
          ).success(note == null ? '备注已清除' : '备注已保存到音频时间线');
        }
      } catch (_) {
        if (mounted) {
          GooToastScope.of(context).error('备注保存失败，请重试');
        }
      } finally {
        if (mounted) setState(() => _annotationSaving = false);
      }
    }
    textController.dispose();
  }

  void _openRenameDialog() {
    unawaited(_showRenameDialog());
  }

  Future<void> _showRenameDialog() async {
    final TextEditingController textController = TextEditingController(
      text: _displayName,
    );
    final bool? saved = await showGooDialog<bool>(
      context: context,
      builder: (BuildContext _) {
        return GooDialog<bool>.custom(
          title: '编辑标题',
          customContentCenterChild: false,
          actions: const <GooDialogAction>[
            GooDialogAction(label: '取消', result: false),
            GooDialogAction(
              label: '保存',
              style: GooDialogActionStyle.primary,
              result: true,
            ),
          ],
          child: GooInput(
            controller: textController,
            label: '录音标题',
            placeholder: '输入录音标题',
            showClearButton: true,
          ),
        );
      },
    );
    if (saved == true && mounted) {
      setState(() {
        _displayName = textController.text.trim().isEmpty
            ? '未命名录音'
            : textController.text.trim();
      });
    }
    textController.dispose();
  }

  Future<void> _handleStop() async {
    final bool saved = await _controller.stop();
    if (!mounted) return;
    if (saved) {
      GooToastScope.of(context).success('录音已保存');
      setState(() {
        _markerTimestamps.clear();
      });
    }
  }

  Future<void> _handleCenterAction() async {
    if (_controller.canStart) {
      final bool consented = await _ensureRecordingConsent();
      if (!consented || !mounted) return;
      await _controller.start();
      return;
    }
    if (_controller.canStop) {
      await _handleStop();
    }
  }

  Future<bool> _ensureRecordingConsent() async {
    if (await _controller.hasCurrentRecordingConsent()) {
      await _refreshNotificationPermissionState(requestIfNeeded: false);
      return true;
    }
    if (!mounted) return false;
    final bool? accepted = await showGooDialog<bool>(
      context: context,
      dismissible: false,
      builder: (BuildContext context) {
        return const GooDialog<bool>.confirmation(
          title: '开始音频录音',
          description:
              '请先确认已获得参会者同意。录音与离线转写默认只在本机处理；'
              '锁屏或切到后台后，系统通知会持续显示录音状态。',
          actionLayout: GooDialogActionLayout.horizontal,
          actions: <GooDialogAction>[
            GooDialogAction(label: '取消', result: false),
            GooDialogAction(
              label: '已获得同意',
              style: GooDialogActionStyle.primary,
              result: true,
            ),
          ],
        );
      },
    );
    if (accepted != true) return false;
    await _controller.acceptRecordingConsent();
    await _refreshNotificationPermissionState(requestIfNeeded: true);
    return true;
  }

  Future<void> _refreshNotificationPermissionState({
    required bool requestIfNeeded,
  }) async {
    if (!widget.notificationPermissionEnabled) return;
    PermissionStatus status = await Permission.notification.status;
    if (requestIfNeeded && status.isDenied) {
      status = await Permission.notification.request();
    }
    if (!mounted) return;
    setState(() {
      _showNotificationPermissionWarning = !status.isGranted;
    });
  }

  Future<void> _showRecoveryPanelIfNeeded() async {
    if (_recoveryPanelOpen || _controller.recoveryCandidates.isEmpty) return;
    _recoveryPanelOpen = true;
    await showGooPanel<void>(
      context: context,
      title: '恢复未完成录音',
      useRootNavigator: true,
      enableBackdropDismiss: false,
      enableDragDismiss: false,
      builder:
          (
            BuildContext context,
            GooPanelController<void> panelController,
            ScrollController scrollController,
          ) {
            return RecordingRecoveryPanel(
              candidates: _controller.recoveryCandidates,
              onRecover: _controller.recoverRecording,
              onDiscard: _controller.discardRecovery,
              onAllResolved: panelController.close,
            );
          },
    );
    _recoveryPanelOpen = false;
  }

  Future<void> _openInputDevicePanel() async {
    if (_inputDevicePanelOpen ||
        _controller.phase == RecordingPhase.starting ||
        _controller.phase == RecordingPhase.stopping) {
      return;
    }
    _inputDevicePanelOpen = true;
    final bool loaded = await _controller.refreshInputDevices();
    if (!mounted) return;
    if (!loaded) {
      _inputDevicePanelOpen = false;
      GooToastScope.of(
        context,
      ).error(_controller.inputRouteNotice ?? '读取录音输入设备失败');
      return;
    }

    final String? selection = await showGooPanel<String>(
      context: context,
      title: '录音输入设备',
      semanticLabel: '选择录音输入设备',
      useRootNavigator: true,
      builder:
          (
            BuildContext context,
            GooPanelController<String> panelController,
            ScrollController scrollController,
          ) {
            final List<Widget> deviceRows = <Widget>[
              GooListItem(
                title: '系统自动选择',
                subtitle: '设备断开时优先回退到此模式，录音继续',
                selected: _controller.preferredInputDeviceId == null,
                semanticLabel:
                    '系统自动选择${_controller.preferredInputDeviceId == null ? '，当前选中' : ''}',
                onTap: () =>
                    panelController.closeWithResult(_automaticInputSelection),
              ),
              for (final device in _controller.inputDevices)
                GooListItem(
                  title: device.name,
                  subtitle: device.canSelect
                      ? '${_inputDeviceTypeLabel(device.type)} · 可主动切换'
                      : '${_inputDeviceTypeLabel(device.type)} · 当前系统仅可查看',
                  selected: _controller.preferredInputDeviceId == device.id,
                  disabled: !device.canSelect,
                  semanticLabel:
                      '${device.name}，${device.canSelect ? '可选择' : '当前系统不支持主动切换'}'
                      '${_controller.preferredInputDeviceId == device.id ? '，当前选中' : ''}',
                  onTap: () =>
                      panelController.closeWithResult(device.id.toString()),
                ),
            ];
            return ListView(
              controller: scrollController,
              padding: EdgeInsets.zero,
              children: <Widget>[
                const GooText(
                  'Android 6 及以上可主动选择输入。所选设备断开时会先回退系统默认输入；'
                  '只有无法安全回退时才停止并保存录音。',
                  variant: GooTextVariant.body,
                ),
                const SizedBox(height: 16),
                GooList(style: GooListStyle.plain, children: deviceRows),
              ],
            );
          },
    );
    _inputDevicePanelOpen = false;
    if (!mounted || selection == null) return;
    final int? deviceId = selection == _automaticInputSelection
        ? null
        : int.tryParse(selection);
    final bool selected = await _controller.selectInputDevice(deviceId);
    if (!mounted) return;
    if (selected) {
      GooToastScope.of(
        context,
      ).success('录音输入已设为${_controller.preferredInputDeviceName}');
    } else {
      GooToastScope.of(
        context,
      ).error(_controller.inputRouteNotice ?? '切换录音输入失败');
    }
  }

  void _handleRightAction() {
    if (_isIdleLike) {
      Navigator.of(context).maybePop();
      return;
    }
    _controller.togglePrimaryAction();
  }

  Future<void> _handleAddMarker() async {
    final String? sessionId = _controller.activeSessionId;
    if (sessionId == null ||
        !_controller.canStop ||
        _annotationsLoading ||
        _annotationSaving) {
      return;
    }
    _annotationLoadEpoch += 1;
    setState(() => _annotationSaving = true);
    try {
      final marker = await _recordingAnnotationsRepository.addMarker(
        sessionId: sessionId,
        positionMs: _controller.elapsedMs,
      );
      if (!mounted || _annotationSessionId != sessionId) return;
      setState(() {
        _markerTimestamps
          ..add(marker.positionMs)
          ..sort();
      });
    } catch (_) {
      if (mounted) {
        GooToastScope.of(context).error('重点标记保存失败，请重试');
      }
    } finally {
      if (mounted) setState(() => _annotationSaving = false);
    }
  }

  bool get _isIdleLike =>
      _controller.phase == RecordingPhase.idle ||
      _controller.phase == RecordingPhase.error ||
      _controller.phase == RecordingPhase.starting;

  @override
  Widget build(BuildContext context) {
    final bool isBusy =
        _controller.phase == RecordingPhase.starting ||
        _controller.phase == RecordingPhase.stopping;
    final ({String muted, String focus}) timerDisplay = _splitElapsedDisplay(
      _elapsedPreciseText,
    );
    final List<double> waveHeights = _buildWaveHeights(
      _controller.inputAmplitudeWindow,
      _controller.phase,
    );
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      body: Container(
        color: const Color(0xFFF5F7FA),
        child: SafeArea(
          bottom: false,
          child: Column(
            children: <Widget>[
              if (_showNotificationPermissionWarning)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                  child: GooTopTip.button(
                    message: '系统通知权限未开启；录音可继续，但通知栏可能不显示状态。',
                    maxLines: 2,
                    variant: GooTopTipVariant.warning,
                    primaryActionLabel: '去设置',
                    onPrimaryAction: openAppSettings,
                  ),
                ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                  child: Column(
                    children: <Widget>[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Expanded(
                            child: _SessionHeader(
                              title: _displayName,
                              subtitle: _headerSubtitle,
                              onEditTitle: _openRenameDialog,
                            ),
                          ),
                          const SizedBox(width: 12),
                          _PillButton(
                            icon: Icons.edit_outlined,
                            label: '备注',
                            onPressed:
                                _controller.canStop &&
                                    !_annotationsLoading &&
                                    !_annotationSaving
                                ? _openRemarkSheet
                                : null,
                          ),
                        ],
                      ),
                      const SizedBox(height: 52),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: <Widget>[
                          Text(
                            timerDisplay.muted,
                            style: const TextStyle(
                              fontSize: 68,
                              fontWeight: FontWeight.w300,
                              color: Color(0xFF94A3B8),
                              height: 0.95,
                              fontFeatures: _tabular,
                            ),
                          ),
                          Text(
                            timerDisplay.focus,
                            style: const TextStyle(
                              fontSize: 68,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF111827),
                              height: 0.95,
                              fontFeatures: _tabular,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 52),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: _rulerLabels
                            .map(
                              (String label) => Expanded(
                                child: Text(
                                  label,
                                  maxLines: 1,
                                  overflow: TextOverflow.clip,
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                    color: Color(0xFF94A3B8),
                                    fontSize: 14,
                                    fontWeight: FontWeight.w400,
                                    fontFeatures: _tabular,
                                  ),
                                ),
                              ),
                            )
                            .toList(),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: List<Widget>.generate(_rulerTickCount, (
                          int index,
                        ) {
                          return Container(
                            width: 1,
                            height: index % 4 == 0 ? 16 : 8,
                            decoration: BoxDecoration(
                              color: const Color(
                                0xFF94A3B8,
                              ).withValues(alpha: index % 4 == 0 ? 0.72 : 0.36),
                              borderRadius: BorderRadius.circular(999),
                            ),
                          );
                        }),
                      ),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(top: 28),
                          child: LayoutBuilder(
                            builder:
                                (
                                  BuildContext context,
                                  BoxConstraints constraints,
                                ) {
                                  return Stack(
                                    children: <Widget>[
                                      Positioned(
                                        left: constraints.maxWidth / 2 - 0.5,
                                        top: 0,
                                        bottom: 0,
                                        child: Container(
                                          width: 1,
                                          color: const Color(0xFFEF4444),
                                        ),
                                      ),
                                      Positioned(
                                        top: math.max(
                                          56,
                                          constraints.maxHeight * 0.26,
                                        ),
                                        left: 0,
                                        right: 0,
                                        child: Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.spaceBetween,
                                          crossAxisAlignment:
                                              CrossAxisAlignment.center,
                                          children: List<Widget>.generate(
                                            _waveSegmentCount,
                                            (int index) {
                                              final bool beforeCenter =
                                                  index < _waveCenterIndex;
                                              return Container(
                                                width: 3,
                                                height: waveHeights[index],
                                                decoration: BoxDecoration(
                                                  color: beforeCenter
                                                      ? const Color(0xFF111827)
                                                      : const Color(0xFF94A3B8),
                                                  borderRadius:
                                                      BorderRadius.circular(
                                                        999,
                                                      ),
                                                ),
                                                foregroundDecoration:
                                                    BoxDecoration(
                                                      color: Colors.white
                                                          .withValues(
                                                            alpha: beforeCenter
                                                                ? 0.02
                                                                : 0.48,
                                                          ),
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                            999,
                                                          ),
                                                    ),
                                              );
                                            },
                                          ),
                                        ),
                                      ),
                                    ],
                                  );
                                },
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Container(
                width: double.infinity,
                color: const Color(0xFFF5F7FA),
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 0),
                child: Column(
                  children: <Widget>[
                    Semantics(
                      liveRegion: true,
                      label:
                          _controller.errorMessage ??
                          _controller.inputRouteNotice ??
                          _inputStatusText,
                      child: Text(
                        _controller.errorMessage ??
                            _controller.inputRouteNotice ??
                            '$_inputStatusText · 标记数 ${_markerTimestamps.length}',
                        style: TextStyle(
                          color: _controller.errorMessage == null
                              ? const Color(0xFF94A3B8)
                              : theme.colorScheme.error,
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 4),
                    GooButton.text(
                      onPressed: isBusy ? null : _openInputDevicePanel,
                      child: Text(
                        '输入设备：${_controller.preferredInputDeviceName}',
                      ),
                    ),
                    if (_controller.permissionDenied) ...<Widget>[
                      const SizedBox(height: 8),
                      GooButton.text(
                        onPressed: openAppSettings,
                        iconName: GooIcons.settings,
                        child: const Text('去系统设置开启权限'),
                      ),
                    ],
                    const SizedBox(height: 14),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: <Widget>[
                        _RoundControlButton(
                          size: 72,
                          backgroundColor: Colors.white,
                          icon: Icons.flag_outlined,
                          iconColor: const Color(0xFF111827),
                          disabled:
                              !_controller.canStop ||
                              isBusy ||
                              _annotationsLoading ||
                              _annotationSaving,
                          onPressed: () => unawaited(_handleAddMarker()),
                        ),
                        _RoundControlButton(
                          size: 88,
                          backgroundColor: _controller.canStop
                              ? const Color(0xFFEF4444)
                              : Colors.white,
                          icon: _controller.canStop
                              ? Icons.stop_rounded
                              : Icons.mic_rounded,
                          iconColor: _controller.canStop
                              ? Colors.white
                              : const Color(0xFFEF4444),
                          disabled:
                              (!_controller.canStop && !_controller.canStart) ||
                              isBusy,
                          onPressed: _handleCenterAction,
                        ),
                        _RoundControlButton(
                          size: 72,
                          backgroundColor: _isIdleLike
                              ? Colors.white
                              : const Color(0xFF1E6BFF),
                          icon: _isIdleLike
                              ? Icons.arrow_back_rounded
                              : _controller.phase == RecordingPhase.paused
                              ? Icons.play_arrow_rounded
                              : Icons.pause_rounded,
                          iconColor: _isIdleLike
                              ? const Color(0xFF111827)
                              : Colors.white,
                          disabled: isBusy,
                          onPressed: _handleRightAction,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Text(
                      _bottomHint,
                      style: const TextStyle(
                        color: Color(0xFF94A3B8),
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        fontFeatures: _tabular,
                      ),
                    ),
                    SizedBox(
                      height: MediaQuery.of(context).padding.bottom + 12,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String get _elapsedPreciseText {
    final int totalSeconds = (_controller.elapsedMs / 1000).floor();
    final int minutes = totalSeconds ~/ 60;
    final int seconds = totalSeconds % 60;
    return '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
  }

  String get _headerSubtitle {
    final DateTime now = DateTime.now();
    final String mm = now.month.toString().padLeft(2, '0');
    final String dd = now.day.toString().padLeft(2, '0');
    final String hh = now.hour.toString().padLeft(2, '0');
    final String min = now.minute.toString().padLeft(2, '0');
    return '$mm-$dd $hh:$min · ${_phaseLabel(_controller.phase)}';
  }

  String get _bottomHint {
    if (_controller.phase == RecordingPhase.recording ||
        _controller.phase == RecordingPhase.paused) {
      return '录音中 $_elapsedPreciseText';
    }
    if (_controller.phase == RecordingPhase.stopping) {
      return '正在停止录音...';
    }
    if (_controller.phase == RecordingPhase.starting) {
      return '正在启动录音...';
    }
    return '点击中间按钮开始录音';
  }

  String get _inputStatusText {
    if (_controller.phase == RecordingPhase.paused ||
        _controller.inputStatus == RecordingInputStatus.paused) {
      return '录音已暂停';
    }
    final String device = _controller.inputDeviceName?.trim().isNotEmpty == true
        ? _controller.inputDeviceName!.trim()
        : _inputDeviceTypeLabel(_controller.inputDeviceType);
    return switch (_controller.inputStatus) {
      RecordingInputStatus.available => '$device · 输入正常',
      RecordingInputStatus.silent => '$device · 当前静音',
      RecordingInputStatus.paused => '录音已暂停',
      RecordingInputStatus.unknown => '输入状态未知',
    };
  }

  String _inputDeviceTypeLabel(RecordingInputDeviceType type) {
    return switch (type) {
      RecordingInputDeviceType.builtIn => '内置麦克风',
      RecordingInputDeviceType.wired => '有线麦克风',
      RecordingInputDeviceType.bluetooth => '蓝牙麦克风',
      RecordingInputDeviceType.usb => 'USB 麦克风',
      RecordingInputDeviceType.external => '外部麦克风',
      RecordingInputDeviceType.unknown => '输入设备未知',
    };
  }

  String _phaseLabel(RecordingPhase phase) {
    switch (phase) {
      case RecordingPhase.idle:
        return '待机';
      case RecordingPhase.starting:
        return '启动中';
      case RecordingPhase.recording:
        return '录音中';
      case RecordingPhase.paused:
        return '已暂停';
      case RecordingPhase.stopping:
        return '停止中';
      case RecordingPhase.error:
        return '异常';
    }
  }
}

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.title,
    required this.subtitle,
    required this.onEditTitle,
  });

  final String title;
  final String subtitle;
  final VoidCallback onEditTitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        GestureDetector(
          onTap: onEditTitle,
          child: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 30,
              fontWeight: FontWeight.w700,
              color: Color(0xFF111827),
              height: 1.05,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          subtitle,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: Color(0xFF94A3B8),
          ),
        ),
      ],
    );
  }
}

class _PillButton extends StatelessWidget {
  const _PillButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onPressed == null ? 0.55 : 1,
      child: Material(
        color: Colors.white,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(999),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(icon, size: 16, color: const Color(0xFF111827)),
                const SizedBox(width: 6),
                Text(
                  label,
                  style: const TextStyle(
                    color: Color(0xFF111827),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RoundControlButton extends StatelessWidget {
  const _RoundControlButton({
    required this.size,
    required this.backgroundColor,
    required this.icon,
    required this.iconColor,
    required this.disabled,
    required this.onPressed,
  });

  final double size;
  final Color backgroundColor;
  final IconData icon;
  final Color iconColor;
  final bool disabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: disabled ? 0.55 : 1,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: disabled ? null : onPressed,
          borderRadius: BorderRadius.circular(size / 2),
          child: Ink(
            width: size,
            height: size,
            decoration: BoxDecoration(
              color: backgroundColor,
              shape: BoxShape.circle,
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: const Color(0x14000000),
                  blurRadius: 16,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Icon(icon, color: iconColor, size: size == 88 ? 34 : 28),
          ),
        ),
      ),
    );
  }
}

({String muted, String focus}) _splitElapsedDisplay(String elapsedPreciseText) {
  final String normalized = elapsedPreciseText.replaceAll('.', ':');
  final int splitIndex = normalized.lastIndexOf(':');
  if (splitIndex <= 0) {
    return (muted: normalized, focus: '');
  }

  return (
    muted: normalized.substring(0, splitIndex + 1),
    focus: normalized.substring(splitIndex + 1),
  );
}

List<double> _buildWaveHeights(List<double> amplitudes, RecordingPhase phase) {
  return List<double>.generate(_waveSegmentCount, (int index) {
    if (phase != RecordingPhase.recording || index >= _waveCenterIndex) {
      return 3;
    }
    final int sampleIndex = amplitudes.length - _waveCenterIndex + index;
    final double amplitude = sampleIndex >= 0 && sampleIndex < amplitudes.length
        ? amplitudes[sampleIndex].clamp(0, 1).toDouble()
        : 0;
    return 3 + amplitude * 24;
  });
}
