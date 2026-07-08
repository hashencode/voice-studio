import 'dart:io' show Platform;
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../records/repository/recordings_repository.dart';
import '../settings/repository/app_settings_repository.dart';
import '../transcription/repository/transcription_jobs_repository.dart';
import '../transcription/service/android_transcription_service.dart';
import '../transcription/service/fake_transcription_service.dart';
import '../transcription/service/transcription_port.dart';
import 'controller/recording_controller.dart';
import 'engine/android_recorder_engine.dart';
import 'engine/fake_recorder_engine.dart';
import 'engine/recorder_port.dart';
import 'model/recording_phase.dart';
import 'services/microphone_permission_service.dart';

const List<String> _rulerLabels = <String>['00:02', '00:04', '00:06', '00:08'];
const int _rulerTickCount = 22;
const int _waveSegmentCount = 72;
const int _waveCenterIndex = _waveSegmentCount ~/ 2;
const List<FontFeature> _tabular = <FontFeature>[FontFeature.tabularFigures()];

class RecordingPage extends StatefulWidget {
  const RecordingPage({super.key});

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage>
    with WidgetsBindingObserver {
  late final RecordingController _controller;
  bool _interruptionHandling = false;
  String? _pendingInterruptionNotice;
  String _displayName = '未命名录音';
  String _remarkText = '';
  final List<int> _markerTimestamps = <int>[];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller = RecordingController(
      permissionService: MicrophonePermissionService(),
      recorder: _buildRecorder(),
      recordingsRepository: RecordingsRepository(),
      transcriptionJobsRepository: TranscriptionJobsRepository(),
      transcriptionService: _buildTranscriptionService(),
      appSettingsRepository: AppSettingsRepository(),
    );
    _controller.addListener(_onControllerChanged);
    _controller.reloadSettings();
  }

  TranscriptionPort _buildTranscriptionService() {
    if (Platform.isAndroid) {
      return AndroidTranscriptionService();
    }
    return FakeTranscriptionService();
  }

  RecorderPort _buildRecorder() {
    if (Platform.isAndroid) {
      return AndroidRecorderEngine();
    }
    return FakeRecorderEngine();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.removeListener(_onControllerChanged);
    _controller.dispose();
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
      _flushPendingInterruptionNotice();
    }
  }

  void _onControllerChanged() {
    if (!mounted) return;
    setState(() {});
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

    if (result == InterruptionResult.autoSaved) {
      _pendingInterruptionNotice = '录音因系统中断已自动停止并保存';
    } else if (result == InterruptionResult.failed) {
      _pendingInterruptionNotice = '录音被系统中断，自动保存失败，请重试';
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
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _openRemarkSheet() async {
    final TextEditingController textController = TextEditingController(
      text: _remarkText,
    );
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (BuildContext context) {
        return Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            20,
            20,
            MediaQuery.of(context).viewInsets.bottom + 20,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                '灵感速记',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF111827),
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: textController,
                maxLines: 7,
                minLines: 6,
                decoration: InputDecoration(
                  hintText: '输入灵感速记',
                  filled: true,
                  fillColor: const Color(0xFFF8FAFC),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () {
                    setState(() {
                      _remarkText = textController.text.trim();
                    });
                    Navigator.of(context).pop();
                  },
                  child: const Text('保存备注'),
                ),
              ),
            ],
          ),
        );
      },
    );
    textController.dispose();
  }

  void _openRenameDialog() {
    final TextEditingController textController = TextEditingController(
      text: _displayName,
    );
    showDialog<void>(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text('编辑标题'),
          content: TextField(
            controller: textController,
            autofocus: true,
            decoration: const InputDecoration(hintText: '输入录音标题'),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                setState(() {
                  _displayName = textController.text.trim().isEmpty
                      ? '未命名录音'
                      : textController.text.trim();
                });
                Navigator.of(context).pop();
              },
              child: const Text('保存'),
            ),
          ],
        );
      },
    ).then((_) => textController.dispose());
  }

  Future<void> _handleStop() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final bool saved = await _controller.stop();
    if (!mounted) return;
    if (saved) {
      messenger.showSnackBar(const SnackBar(content: Text('录音已保存')));
      setState(() {
        _markerTimestamps.clear();
      });
    }
  }

  void _handleRightAction() {
    if (_isIdleLike) {
      Navigator.of(context).maybePop();
      return;
    }
    _controller.togglePrimaryAction();
  }

  void _handleAddMarker() {
    if (!_controller.canStop) return;
    setState(() {
      _markerTimestamps.add(_controller.elapsedMs);
    });
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
      _controller.elapsedMs,
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
                            label: '编辑',
                            onPressed: _openRemarkSheet,
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
                              (String label) => Text(
                                label,
                                style: const TextStyle(
                                  color: Color(0xFF94A3B8),
                                  fontSize: 22,
                                  fontWeight: FontWeight.w400,
                                  fontFeatures: _tabular,
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
                    Text(
                      _controller.errorMessage ??
                          '标记数 ${_markerTimestamps.length}',
                      style: TextStyle(
                        color: _controller.errorMessage == null
                            ? const Color(0xFF94A3B8)
                            : theme.colorScheme.error,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    if (_controller.permissionDenied) ...<Widget>[
                      const SizedBox(height: 8),
                      TextButton.icon(
                        onPressed: openAppSettings,
                        icon: const Icon(Icons.settings_outlined),
                        label: const Text('去系统设置开启权限'),
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
                          disabled: !_controller.canStop || isBusy,
                          onPressed: _handleAddMarker,
                        ),
                        _RoundControlButton(
                          size: 88,
                          backgroundColor: _controller.canStop
                              ? const Color(0xFFEF4444)
                              : Colors.white,
                          icon: Icons.stop_rounded,
                          iconColor: _controller.canStop
                              ? Colors.white
                              : const Color(0xFF94A3B8),
                          disabled: !_controller.canStop || isBusy,
                          onPressed: _handleStop,
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
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
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
              const Icon(
                Icons.edit_outlined,
                size: 16,
                color: Color(0xFF111827),
              ),
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

List<double> _buildWaveHeights(int elapsedMs, RecordingPhase phase) {
  final bool isLive =
      phase == RecordingPhase.recording || phase == RecordingPhase.paused;
  final int frame = elapsedMs ~/ 90;

  return List<double>.generate(_waveSegmentCount, (int index) {
    if (index >= _waveCenterIndex) {
      return 3;
    }

    if (!isLive) {
      return index % 3 == 0 ? 8 : 6;
    }

    final double signalA = math.sin((index + frame) * 0.42);
    final double signalB = math.cos((index * 0.68 + frame) * 0.26);
    return 6 + (signalA + signalB).abs() * 9;
  });
}
