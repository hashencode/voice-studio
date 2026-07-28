import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:qr/qr.dart';

import '../features/companion/desktop_companion_repository.dart';
import '../features/capture/desktop_capture_preflight_page.dart';
import '../features/capture/desktop_capture_recovery_page.dart';
import '../features/capture/desktop_capture_view_model.dart';
import '../features/capture/desktop_recording_workspace.dart';
import '../features/meetings/playback/desktop_meeting_playback.dart';
import '../features/processing/desktop_job.dart';
import '../features/security/desktop_disk_encryption.dart';
import '../features/settings/desktop_ai_provider_settings_repository.dart';
import 'desktop_home_model.dart';
import 'desktop_workstation_model.dart';

class Voice2TextDesktopApp extends StatelessWidget {
  const Voice2TextDesktopApp({super.key, required this.homeModel});

  final DesktopHomeModel homeModel;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Voice2Text 桌面工作站',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF18181B),
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: GooShowcaseColors.light.background,
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFE4E4E7),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: GooShowcaseColors.dark.background,
        useMaterial3: true,
      ),
      builder: (context, child) => GooToastScope(
        child: GooSnackbarScope(child: child ?? const SizedBox.shrink()),
      ),
      home: homeModel is DesktopWorkstationModel
          ? _DesktopWorkstationPage(model: homeModel as DesktopWorkstationModel)
          : _LegacyDesktopHomePage(model: homeModel),
    );
  }
}

class _DesktopWorkstationPage extends StatefulWidget {
  const _DesktopWorkstationPage({required this.model});

  final DesktopWorkstationModel model;

  @override
  State<_DesktopWorkstationPage> createState() =>
      _DesktopWorkstationPageState();
}

class _DesktopWorkstationPageState extends State<_DesktopWorkstationPage> {
  @override
  void initState() {
    super.initState();
    widget.model.load();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.model,
      builder: (context, _) {
        final model = widget.model;
        return CallbackShortcuts(
          bindings: <ShortcutActivator, VoidCallback>{
            const SingleActivator(LogicalKeyboardKey.keyO, meta: true):
                model.importMeeting,
            const SingleActivator(
              LogicalKeyboardKey.keyR,
              meta: true,
              shift: true,
            ): model.captureController.preflight,
            const SingleActivator(LogicalKeyboardKey.keyZ, meta: true):
                model.undoTranscript,
            const SingleActivator(
              LogicalKeyboardKey.keyZ,
              meta: true,
              shift: true,
            ): model.redoTranscript,
            const SingleActivator(LogicalKeyboardKey.space):
                model.playback.toggle,
          },
          child: Focus(
            autofocus: true,
            child: Scaffold(
              body: LayoutBuilder(
                builder: (context, constraints) {
                  final navigationWidth = constraints.maxWidth >= 1100
                      ? 248.0
                      : 80.0;
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      GooSideNavigation<DesktopWorkstationSection>(
                        width: navigationWidth,
                        height: constraints.maxHeight,
                        title: 'Voice2Text',
                        semanticLabel: '工作站主导航',
                        value: model.section,
                        onValueChange: model.selectSection,
                        showCollapseHandle: false,
                        items:
                            const <
                              GooSideNavigationItem<DesktopWorkstationSection>
                            >[
                              GooSideNavigationItem(
                                value: DesktopWorkstationSection.library,
                                label: '会议',
                                iconName: GooIcons.folder,
                              ),
                              GooSideNavigationItem(
                                value: DesktopWorkstationSection.tasks,
                                label: '任务',
                                iconName: GooIcons.task,
                              ),
                              GooSideNavigationItem(
                                value: DesktopWorkstationSection.companion,
                                label: '手机',
                                iconName: GooIcons.computer,
                              ),
                              GooSideNavigationItem(
                                value: DesktopWorkstationSection.settings,
                                label: '设置',
                                iconName: GooIcons.settings,
                              ),
                            ],
                      ),
                      Expanded(child: _section(model)),
                    ],
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _section(DesktopWorkstationModel model) => switch (model.section) {
    DesktopWorkstationSection.library => _LibraryView(model: model),
    DesktopWorkstationSection.tasks => _TasksView(model: model),
    DesktopWorkstationSection.companion => _CompanionView(model: model),
    DesktopWorkstationSection.settings => _SettingsView(model: model),
  };
}

class _LibraryView extends StatelessWidget {
  const _LibraryView({required this.model});

  final DesktopWorkstationModel model;

  @override
  Widget build(BuildContext context) {
    final capture = model.captureController.value;
    if (capture.recoveries.isNotEmpty &&
        capture.phase == DesktopCapturePhase.idle) {
      return DesktopCaptureRecoveryPage(
        controller: model.captureController,
        model: capture,
      );
    }
    if (capture.phase == DesktopCapturePhase.checking ||
        capture.phase == DesktopCapturePhase.ready ||
        (capture.phase == DesktopCapturePhase.failed &&
            capture.snapshot == null &&
            capture.preflight != null)) {
      return DesktopCapturePreflightPage(
        controller: model.captureController,
        model: capture,
      );
    }
    if (capture.isActive ||
        capture.phase == DesktopCapturePhase.completed ||
        (capture.phase == DesktopCapturePhase.failed &&
            capture.snapshot != null)) {
      return DesktopRecordingWorkspace(
        controller: model.captureController,
        model: capture,
      );
    }
    final selected = model.selectedMeeting;
    if (selected != null) {
      return _MeetingWorkspaceView(model: model, workspace: selected);
    }
    return Column(
      children: <Widget>[
        GooAppBar.primary(
          title: '本机会议',
          subtitle: '音频、转写、修订与导出保存在这台 Mac',
          pageLoadingMode: model.loading ? GooPageLoadingMode.recycle : null,
          pageLoadingAnimated: model.loading,
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1040),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  if (model.errorMessage != null) ...[
                    _MessageCard(
                      title: '需要处理',
                      message: model.errorMessage!,
                      icon: GooIcons.warning,
                    ),
                  ],
                  if (model.noticeMessage != null) ...[
                    const SizedBox(height: 12),
                    _MessageCard(
                      title: '已完成',
                      message: model.noticeMessage!,
                      icon: GooIcons.done,
                    ),
                  ],
                  const SizedBox(height: 24),
                  Row(
                    children: <Widget>[
                      const Expanded(
                        child: GooText(
                          '会议资料库',
                          variant: GooTextVariant.heading,
                        ),
                      ),
                      GooButton(
                        key: const ValueKey('start_meeting_button'),
                        iconName: GooIcons.phoneRecord,
                        onPressed: model.captureController.preflight,
                        child: const GooText('开始会议'),
                      ),
                      const SizedBox(width: 8),
                      model.importing
                          ? GooButton.loading(
                              variant: GooButtonVariant.secondary,
                              onPressed: null,
                              child: const GooText('正在安全导入'),
                            )
                          : GooButton(
                              key: const ValueKey('import_meeting_button'),
                              iconName: GooIcons.add,
                              variant: GooButtonVariant.secondary,
                              onPressed: model.importMeeting,
                              child: const GooText('导入文件'),
                            ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (model.loading)
                    const Padding(
                      padding: EdgeInsets.all(40),
                      child: Center(child: GooInlineLoader()),
                    )
                  else if (model.meetings.isEmpty)
                    GooResult(
                      title: '还没有本机会议',
                      description: '直接开始电脑会议，或导入已有音频/视频。录音会分别保存系统音频和麦克风。',
                      buttonLabel: '开始电脑会议',
                      onButtonPressed: model.captureController.preflight,
                    )
                  else
                    GooList(
                      children: model.meetings
                          .map(
                            (meeting) => GooListItem(
                              key: ValueKey('meeting_${meeting.recordingId}'),
                              title: meeting.displayName,
                              subtitle:
                                  '${_duration(meeting.durationMs)} · '
                                  '${meeting.segmentCount} 个转写片段',
                              leadingIconName: GooIcons.audio,
                              showGuide: true,
                              trailing: _processingTag(meeting.processingState),
                              onTap: () =>
                                  model.selectMeeting(meeting.recordingId),
                            ),
                          )
                          .toList(growable: false),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _MeetingWorkspaceView extends StatefulWidget {
  const _MeetingWorkspaceView({required this.model, required this.workspace});

  final DesktopWorkstationModel model;
  final MeetingWorkspaceSnapshot workspace;

  @override
  State<_MeetingWorkspaceView> createState() => _MeetingWorkspaceViewState();
}

class _MeetingWorkspaceViewState extends State<_MeetingWorkspaceView> {
  final TextEditingController _searchController = TextEditingController();
  String _tab = 'transcript';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final model = widget.model;
    final workspace = widget.workspace;
    return Column(
      children: <Widget>[
        GooAppBar.primary(
          title: workspace.summary.displayName,
          subtitle:
              '${_duration(workspace.summary.durationMs)} · '
              '${workspace.segments.length} 个片段 · '
              '${_stateLabel(workspace.summary.processingState)}',
          pageLoadingMode: model.workspaceLoading
              ? GooPageLoadingMode.recycle
              : null,
          pageLoadingAnimated: model.workspaceLoading,
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1260),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
                child: Column(
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        GooButton.text(
                          iconName: GooIcons.arrowBack,
                          onPressed: model.closeMeeting,
                          child: const GooText('返回资料库'),
                        ),
                        const Spacer(),
                        GooButton.icon(
                          iconName: GooIcons.undo,
                          semanticLabel: '撤销上次转写编辑',
                          onPressed: workspace.canUndo
                              ? model.undoTranscript
                              : null,
                        ),
                        const SizedBox(width: 8),
                        GooButton.icon(
                          iconName: GooIcons.redo,
                          semanticLabel: '重做上次转写编辑',
                          onPressed: workspace.canRedo
                              ? model.redoTranscript
                              : null,
                        ),
                        const SizedBox(width: 8),
                        GooButton(
                          iconName: GooIcons.download,
                          variant: GooButtonVariant.secondary,
                          onPressed: () => _showExport(context),
                          child: const GooText('导出'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    _PlaybackBar(playback: model.playback),
                    const SizedBox(height: 12),
                    Expanded(
                      child: LayoutBuilder(
                        builder: (context, constraints) {
                          final contentHeight = max(
                            0.0,
                            constraints.maxHeight - 56,
                          );
                          return GooTabs(
                            value: _tab,
                            onValueChange: (value) =>
                                setState(() => _tab = value),
                            enableContentSwipe: false,
                            tabs: <GooTabItem>[
                              GooTabItem(
                                value: 'transcript',
                                label: const GooText('转写与说话人'),
                                child: SizedBox(
                                  height: contentHeight,
                                  child: _TranscriptPane(
                                    model: model,
                                    workspace: workspace,
                                    searchController: _searchController,
                                  ),
                                ),
                              ),
                              GooTabItem(
                                value: 'notes',
                                label: const GooText('会议笔记'),
                                child: SizedBox(
                                  height: contentHeight,
                                  child: _NotesPane(
                                    model: model,
                                    workspace: workspace,
                                  ),
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _showExport(BuildContext context) async {
    final format = await showGooDialog<MeetingWorkspaceExportFormat>(
      context: context,
      builder: (_) => GooDialog.confirmation(
        title: '导出会议',
        description: '导出使用当前已修订转写与匿名说话人标签，不会调用云端服务。',
        actions: const <GooDialogAction>[
          GooDialogAction(label: '取消'),
          GooDialogAction(
            label: '文本',
            result: MeetingWorkspaceExportFormat.text,
          ),
          GooDialogAction(
            label: 'Markdown',
            result: MeetingWorkspaceExportFormat.markdown,
          ),
          GooDialogAction(
            label: 'WebVTT',
            result: MeetingWorkspaceExportFormat.webVtt,
          ),
          GooDialogAction(
            label: 'SRT',
            result: MeetingWorkspaceExportFormat.srt,
          ),
          GooDialogAction(
            label: 'JSON',
            result: MeetingWorkspaceExportFormat.json,
          ),
        ],
      ),
    );
    if (format != null) await widget.model.exportMeeting(format);
  }
}

class _PlaybackBar extends StatelessWidget {
  const _PlaybackBar({required this.playback});

  final DesktopMeetingPlaybackController playback;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: playback,
      builder: (context, _) {
        final state = playback.snapshot;
        final durationMs = max(1, state.duration.inMilliseconds);
        return GooList(
          children: <Widget>[
            GooListItem(
              title: state.error ?? '会议音频',
              subtitle:
                  '${_duration(state.position.inMilliseconds)} / '
                  '${_duration(state.duration.inMilliseconds)} · '
                  '${state.speed.toStringAsFixed(1)}×',
              leading: GooButton.icon(
                iconName: state.playing
                    ? GooIcons.playerPause
                    : GooIcons.playerPlay,
                semanticLabel: state.playing ? '暂停会议音频' : '播放会议音频',
                onPressed: state.initialized ? playback.toggle : null,
              ),
              trailing: SizedBox(
                width: 100,
                child: GooButton.text(
                  onPressed: () => playback.setRate(
                    state.speed >= 2 ? 0.75 : state.speed + 0.25,
                  ),
                  child: GooText('${state.speed.toStringAsFixed(1)}×'),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: GooSlider(
                value: state.position.inMilliseconds
                    .clamp(0, durationMs)
                    .toDouble(),
                max: durationMs.toDouble(),
                onChanged: state.initialized
                    ? (value) =>
                          playback.seek(Duration(milliseconds: value.round()))
                    : null,
                semanticLabel: '会议音频时间轴',
                semanticFormatter: (value) => _duration(value.round()),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _TranscriptPane extends StatelessWidget {
  const _TranscriptPane({
    required this.model,
    required this.workspace,
    required this.searchController,
  });

  final DesktopWorkstationModel model;
  final MeetingWorkspaceSnapshot workspace;
  final TextEditingController searchController;

  @override
  Widget build(BuildContext context) {
    final segments = model.searchQuery.isEmpty
        ? workspace.segments
        : model.searchResults;
    final activeSpeakers = workspace.speakers
        .where((speaker) => speaker.mergedIntoSpeakerId == null)
        .toList(growable: false);
    return Column(
      children: <Widget>[
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            Expanded(
              child: GooSearchBar(
                controller: searchController,
                mode: GooSearchBarMode.defaultBar,
                activatedMode: GooSearchBarMode.activatedInstant,
                placeholder: '搜索转写（⌘F）',
                cancelLabel: '取消',
                onSearch: model.searchTranscript,
                onCancel: () {
                  searchController.clear();
                  model.searchTranscript('');
                },
              ),
            ),
            const SizedBox(width: 12),
            GooButton(
              iconName: GooIcons.userGroup,
              variant: GooButtonVariant.secondary,
              onPressed: activeSpeakers.isEmpty
                  ? null
                  : () => _showSpeakerEditor(context, model, activeSpeakers),
              child: GooText('说话人 ${activeSpeakers.length}'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: segments.isEmpty
              ? GooResult(
                  title: model.searchQuery.isEmpty ? '转写尚未完成' : '没有匹配片段',
                  description: model.searchQuery.isEmpty
                      ? '音频始终保留；可在任务区查看识别与说话人分离状态。'
                      : '尝试更短的关键词。',
                )
              : Semantics(
                  label: '按时间排序的会议转写',
                  child: ListView.builder(
                    key: const ValueKey('transcript_virtual_list'),
                    itemCount: segments.length,
                    itemBuilder: (context, index) {
                      final segment = segments[index];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: GooList(
                          children: <Widget>[
                            GooListItem(
                              key: ValueKey('segment_${segment.id}'),
                              title: segment.text,
                              subtitle:
                                  '${_duration(segment.startMs)} · '
                                  '${_speakerLabel(segment)} · '
                                  '${_reviewLabel(segment.reviewState)}',
                              leadingIconName:
                                  segment.speakerState ==
                                      MeetingWorkspaceSpeakerState.overlap
                                  ? GooIcons.userGroup
                                  : GooIcons.user,
                              showGuide: true,
                              trailing: GooTag(
                                label: _reviewLabel(segment.reviewState),
                                accent:
                                    segment.reviewState ==
                                        MeetingWorkspaceReviewState.reviewed
                                    ? GooTagAccent.green
                                    : GooTagAccent.orange,
                                variant: GooTagVariant.capsule,
                              ),
                              onTap: () =>
                                  _showSegmentEditor(context, model, segment),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }
}

class _NotesPane extends StatelessWidget {
  const _NotesPane({required this.model, required this.workspace});

  final DesktopWorkstationModel model;
  final MeetingWorkspaceSnapshot workspace;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        const SizedBox(height: 12),
        GooList(
          children: <Widget>[
            GooListItem(
              title: '可选 ${model.aiProviderSettings.displayName} 会议笔记',
              subtitle: model.aiSecretConfigured
                  ? '密钥保存在 macOS 钥匙串；每次会议仍需单独同意。'
                  : '未配置密钥。所有本机识别、编辑、搜索与导出仍可使用。',
              leadingIconName: GooIcons.keyPointsSummary,
              trailing: model.aiGenerating
                  ? GooButton.loading(
                      onPressed: null,
                      child: const GooText('生成中'),
                    )
                  : GooButton(
                      onPressed:
                          model.aiSecretConfigured &&
                              workspace.segments.isNotEmpty
                          ? () => _askAiConsent(context, model)
                          : null,
                      child: const GooText('生成草稿'),
                    ),
            ),
          ],
        ),
        if (model.aiMessage != null) ...[
          const SizedBox(height: 8),
          _MessageCard(
            title: '会议笔记',
            message: model.aiMessage!,
            icon: GooIcons.info,
          ),
        ],
        const SizedBox(height: 12),
        Expanded(
          child: workspace.insights.isEmpty
              ? const GooResult(
                  title: '还没有会议笔记',
                  description: '云端笔记是独立可选任务；失败或未同意都不会影响音频与本机转写。',
                )
              : ListView.builder(
                  itemCount: workspace.insights.length,
                  itemBuilder: (context, index) {
                    final insight = workspace.insights[index];
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: GooList(
                        children: <Widget>[
                          GooListItem(
                            title: insight.body,
                            subtitle:
                                '${insight.kind} · '
                                '${insight.evidenceSegmentIds.length} 条证据 · '
                                '${insight.status}',
                            leadingIconName: GooIcons.document,
                            showGuide: true,
                            onTap: () =>
                                _showInsightEditor(context, model, insight),
                          ),
                        ],
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

class _TasksView extends StatelessWidget {
  const _TasksView({required this.model});

  final DesktopWorkstationModel model;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        GooAppBar.primary(
          title: '处理任务',
          subtitle: '识别、说话人分离和会议笔记分别持久化',
          pageLoadingMode: model.processing ? GooPageLoadingMode.recycle : null,
          pageLoadingAnimated: model.processing,
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 960),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  if (model.jobs.isEmpty)
                    const GooResult(
                      title: '没有处理任务',
                      description: '导入会议后，任务会在这里显示完整状态与恢复操作。',
                    )
                  else
                    GooList(
                      children: model.jobs
                          .map(
                            (job) => GooListItem(
                              title: job.displayName,
                              subtitle:
                                  '${_jobDescription(job)} · '
                                  '${(job.progress * 100).round()}%',
                              leadingIconName: GooIcons.task,
                              trailing:
                                  job.state == DesktopJobState.failed ||
                                      job.stage == 'partial_success' ||
                                      job.stage == 'recovery_unknown'
                                  ? GooButton.text(
                                      onPressed: () => model.retryJob(job.id),
                                      child: const GooText('重试'),
                                    )
                                  : _jobTag(job),
                            ),
                          )
                          .toList(growable: false),
                    ),
                  if (model.processing) ...[
                    const SizedBox(height: 16),
                    Align(
                      alignment: Alignment.centerRight,
                      child: GooButton(
                        variant: GooButtonVariant.destructive,
                        onPressed: model.cancelProcessing,
                        child: const GooText('取消当前任务'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _CompanionView extends StatelessWidget {
  const _CompanionView({required this.model});

  final DesktopWorkstationModel model;

  @override
  Widget build(BuildContext context) {
    final invite = model.companionPairingInvite;
    return Column(
      children: <Widget>[
        GooAppBar.primary(
          title: '手机交接',
          subtitle: model.companionListening
              ? '动态端口 ${model.companionPort} · 加密、可恢复、receipt 后手机仍默认保留原件'
              : '局域网接收器未运行；本机导入不受影响',
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 920),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      const Expanded(
                        child: GooText(
                          '配对与身份',
                          variant: GooTextVariant.heading,
                        ),
                      ),
                      GooButton(
                        onPressed: model.companionListening
                            ? model.createCompanionPairingInvite
                            : null,
                        child: const GooText('生成两分钟邀请'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  GooList(
                    children: <Widget>[
                      GooListItem(
                        title: model.companionListening
                            ? '接收器已在私有局域网监听'
                            : '接收器不可用',
                        subtitle: model.companionFingerprint == null
                            ? (model.companionMessage ?? '普通文件导入仍可用')
                            : '本机公钥指纹 ${model.companionFingerprint}',
                        leadingIconName: model.companionListening
                            ? GooIcons.done
                            : GooIcons.warning,
                        trailing: GooTag(
                          label: model.companionListening ? '已加密' : '离线',
                          accent: model.companionListening
                              ? GooTagAccent.green
                              : GooTagAccent.neutral,
                          variant: GooTagVariant.capsule,
                        ),
                      ),
                    ],
                  ),
                  if (invite != null) ...<Widget>[
                    const SizedBox(height: 16),
                    Center(child: _PairingQr(payload: invite.encodedPayload)),
                    const SizedBox(height: 12),
                    _MessageCard(
                      title: '双方确认短码：${invite.shortCode}',
                      message:
                          '在手机“发送到 Mac”中扫描上方二维码；无法扫描时可粘贴下面的内容，'
                          '并确认两端短码一致。邀请到期后不可复用。\n\n'
                          '${invite.encodedPayload}',
                      icon: GooIcons.keyPointsSummary,
                    ),
                  ],
                  if (model.companionMessage != null) ...<Widget>[
                    const SizedBox(height: 12),
                    _MessageCard(
                      title: '局域网状态',
                      message: model.companionMessage!,
                      icon: GooIcons.info,
                    ),
                  ],
                  const SizedBox(height: 24),
                  const GooText('已配对设备', variant: GooTextVariant.heading),
                  const SizedBox(height: 10),
                  GooList(
                    children: model.companionPeers.isEmpty
                        ? const <Widget>[
                            GooListItem(
                              title: '尚未配对手机',
                              subtitle: '发现只提供地址；只有用户核对身份后才建立信任',
                            ),
                          ]
                        : model.companionPeers
                              .map(
                                (peer) => GooListItem(
                                  title: peer.displayName,
                                  subtitle:
                                      '${peer.trustState} · ${peer.fingerprint}',
                                  leadingIconName: GooIcons.computer,
                                  showGuide: true,
                                  onTap: () =>
                                      _confirmUnpair(context, model, peer),
                                ),
                              )
                              .toList(growable: false),
                  ),
                  const SizedBox(height: 24),
                  Row(
                    children: <Widget>[
                      const Expanded(
                        child: GooText(
                          '接收历史与 receipt',
                          variant: GooTextVariant.heading,
                        ),
                      ),
                      GooButton(
                        variant: GooButtonVariant.secondary,
                        onPressed: model.refreshCompanion,
                        child: const GooText('刷新'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  GooList(
                    children: model.companionHistory.isEmpty
                        ? const <Widget>[
                            GooListItem(
                              title: '暂无手机传输',
                              subtitle:
                                  '断线任务会保留 missing chunk checkpoint；完整哈希和导入 commit 后才会出现 receipt',
                            ),
                          ]
                        : model.companionHistory
                              .map(
                                (item) => GooListItem(
                                  title: item.displayName,
                                  subtitle:
                                      '${item.state} · ${item.sizeBytes} bytes\n'
                                      'SHA-256 ${item.wholeFileSha256}'
                                      '${item.receipt == null ? '' : '\nrecording ${item.receipt!.desktopRecordingId} · ${item.receipt!.committedAtMs}'}',
                                  leadingIconName: item.receipt == null
                                      ? GooIcons.task
                                      : GooIcons.done,
                                  trailing: GooTag(
                                    label: item.receipt == null
                                        ? '可恢复'
                                        : '已签 receipt',
                                    accent: item.receipt == null
                                        ? GooTagAccent.neutral
                                        : GooTagAccent.green,
                                    variant: GooTagVariant.capsule,
                                  ),
                                ),
                              )
                              .toList(growable: false),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _PairingQr extends StatelessWidget {
  const _PairingQr({required this.payload});

  final String payload;

  @override
  Widget build(BuildContext context) {
    final image = QrImage(
      QrCode.fromData(data: payload, errorCorrectLevel: QrErrorCorrectLevel.M),
    );
    return Semantics(
      label: '手机配对二维码',
      image: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: CustomPaint(
            size: const Size.square(220),
            painter: _QrPainter(image),
          ),
        ),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter(this.image);

  final QrImage image;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.white);
    final module = size.shortestSide / image.moduleCount;
    final paint = Paint()..color = Colors.black;
    for (var row = 0; row < image.moduleCount; row++) {
      for (var column = 0; column < image.moduleCount; column++) {
        if (!image.isDark(row, column)) continue;
        canvas.drawRect(
          Rect.fromLTWH(column * module, row * module, module, module),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _QrPainter oldDelegate) =>
      oldDelegate.image != image;
}

Future<void> _confirmUnpair(
  BuildContext context,
  DesktopWorkstationModel model,
  DesktopCompanionPeer peer,
) async {
  final confirmed = await showGooDialog<bool>(
    context: context,
    builder: (_) => GooDialog.confirmation(
      title: '撤销 ${peer.displayName}？',
      description:
          '将删除钥匙串凭据、未完成 checkpoint 和该设备的 receipt 元数据。已提交会议保留；此设备再次连接必须重新配对。',
      actions: const <GooDialogAction>[
        GooDialogAction(label: '取消', result: false),
        GooDialogAction(
          label: '撤销设备',
          result: true,
          tone: GooDialogActionTone.destructive,
        ),
      ],
    ),
  );
  if (confirmed == true) {
    await model.unpairCompanion(peer.deviceId);
  }
}

class _SettingsView extends StatelessWidget {
  const _SettingsView({required this.model});

  final DesktopWorkstationModel model;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        const GooAppBar.primary(title: '设置', subtitle: '准入模型、隐私边界与会议智能提供商'),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 840),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  const GooText('本机处理', variant: GooTextVariant.heading),
                  const SizedBox(height: 10),
                  GooList(
                    children: <Widget>[
                      GooListItem(
                        title: model.engineAvailable
                            ? 'Sherpa macOS 准入模型已安装'
                            : 'Sherpa macOS 准入模型未安装',
                        subtitle: model.engineAvailabilityMessage,
                        leadingIconName: model.engineAvailable
                            ? GooIcons.done
                            : GooIcons.download,
                        trailing: model.installingModels
                            ? GooButton.progress(
                                progress: model.modelInstallProgress,
                                onPressed: null,
                                child: GooText(
                                  '${(model.modelInstallProgress * 100).round()}%',
                                ),
                              )
                            : GooButton(
                                onPressed: model.engineAvailable
                                    ? null
                                    : () => _installLocalModels(context, model),
                                child: GooText(
                                  model.engineAvailable ? '已验证' : '安装模型',
                                ),
                              ),
                      ),
                      const GooListItem(
                        title: '固定处理引擎',
                        subtitle:
                            'Sherpa ONNX 1.13.4 · Qwen3-ASR 0.6B int8 · '
                            'pyannote 3.0 segmentation · 3D-Speaker',
                        leadingIconName: GooIcons.info,
                        trailing: GooTag(
                          label: '不可切换',
                          accent: GooTagAccent.neutral,
                          variant: GooTagVariant.capsule,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  const GooText('可选会议智能', variant: GooTextVariant.heading),
                  const SizedBox(height: 10),
                  GooList(
                    children: <Widget>[
                      GooListItem(
                        title:
                            '${model.aiProviderSettings.displayName} · '
                            '${model.aiProviderSettings.modelId}',
                        subtitle: '远程 HTTPS；每场会议必须单独同意，不自动回退。',
                        leadingIconName: GooIcons.settingPermissionsAndPrivacy,
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            if (model.aiProviderProbing)
                              GooButton.loading(
                                onPressed: null,
                                child: const GooText('检查中'),
                              )
                            else
                              GooButton.text(
                                onPressed: model.probeAiProvider,
                                child: const GooText('检查配置'),
                              ),
                            const SizedBox(width: 8),
                            GooButton(
                              onPressed: () =>
                                  _showAiProviderEditor(context, model),
                              child: const GooText('配置'),
                            ),
                          ],
                        ),
                      ),
                      GooListItem(
                        title: model.aiSecretConfigured
                            ? '${model.aiProviderSettings.displayName} 密钥已配置'
                            : '${model.aiProviderSettings.displayName} 密钥未配置',
                        subtitle: '密钥只保存在 macOS 钥匙串，不写入 SQLite、配置、环境变量或诊断。',
                        leadingIconName: GooIcons.keyPointsSummary,
                        trailing: GooButton(
                          onPressed: () => _showSecretEditor(context, model),
                          child: GooText(
                            model.aiSecretConfigured ? '替换' : '输入密钥',
                          ),
                        ),
                      ),
                      if (model.aiSecretConfigured)
                        GooListItem(
                          title:
                              '删除 ${model.aiProviderSettings.displayName} 密钥',
                          subtitle: '删除后，本机识别、编辑、搜索和导出不受影响。',
                          leadingIconName: GooIcons.delete,
                          trailing: GooButton(
                            variant: GooButtonVariant.destructive,
                            onPressed: model.deleteAiSecret,
                            child: const GooText('删除'),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  GooList(
                    children: <Widget>[
                      GooListItem(
                        title: '隐私边界',
                        subtitle:
                            '本机文件闭环默认不联网。只有已配置密钥且针对当前会议明确同意时，'
                            '才会将所选转写文本发送给 ${model.aiProviderSettings.displayName}；'
                            '匿名说话人标签不用于身份识别。',
                        leadingIconName: GooIcons.settingPermissionsAndPrivacy,
                      ),
                      GooListItem(
                        title: switch (model.diskEncryptionStatus) {
                          DesktopDiskEncryptionStatus.enabled =>
                            'FileVault 磁盘加密已启用',
                          DesktopDiskEncryptionStatus.disabled =>
                            'FileVault 磁盘加密未启用',
                          DesktopDiskEncryptionStatus.unknown =>
                            '无法确认 FileVault 状态',
                        },
                        subtitle: switch (model.diskEncryptionStatus) {
                          DesktopDiskEncryptionStatus.enabled =>
                            '会议数据库和音频依赖 macOS 账户隔离与磁盘加密；API 与配对密钥另存于钥匙串。',
                          DesktopDiskEncryptionStatus.disabled =>
                            '会议数据库和音频没有应用层整库加密。建议在系统设置中启用 FileVault；API 与配对密钥仍由钥匙串保护。',
                          DesktopDiskEncryptionStatus.unknown =>
                            '应用未宣称会议数据库或音频有应用层加密。请在系统设置中核对 FileVault；API 与配对密钥仍由钥匙串保护。',
                        },
                        leadingIconName:
                            model.diskEncryptionStatus ==
                                DesktopDiskEncryptionStatus.enabled
                            ? GooIcons.done
                            : GooIcons.warning,
                        trailing: GooTag(
                          label:
                              model.diskEncryptionStatus ==
                                  DesktopDiskEncryptionStatus.enabled
                              ? '已保护'
                              : '需核对',
                          accent:
                              model.diskEncryptionStatus ==
                                  DesktopDiskEncryptionStatus.enabled
                              ? GooTagAccent.green
                              : GooTagAccent.neutral,
                          variant: GooTagVariant.capsule,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({
    required this.title,
    required this.message,
    required this.icon,
  });

  final String title;
  final String message;
  final GooIconId icon;

  @override
  Widget build(BuildContext context) => GooList(
    children: <Widget>[
      GooListItem(title: title, subtitle: message, leadingIconName: icon),
    ],
  );
}

class _LegacyDesktopHomePage extends StatefulWidget {
  const _LegacyDesktopHomePage({required this.model});

  final DesktopHomeModel model;

  @override
  State<_LegacyDesktopHomePage> createState() => _LegacyDesktopHomePageState();
}

class _LegacyDesktopHomePageState extends State<_LegacyDesktopHomePage> {
  @override
  void initState() {
    super.initState();
    widget.model.load();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.model,
      builder: (context, _) => Scaffold(
        appBar: GooAppBar.primary(
          title: '会议工作站',
          subtitle: '本机私有导入与可恢复处理队列',
          pageLoadingMode: widget.model.loading
              ? GooPageLoadingMode.recycle
              : null,
          pageLoadingAnimated: widget.model.loading,
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 960),
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: <Widget>[
                GooList(
                  children: <Widget>[
                    GooListItem(
                      title: widget.model.engineAvailable
                          ? '本机处理引擎可用'
                          : '本机处理引擎尚不可用',
                      subtitle: widget.model.engineAvailabilityMessage,
                      leadingIconName: GooIcons.info,
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                GooButton(
                  onPressed: widget.model.importMeeting,
                  child: const GooText('导入会议文件'),
                ),
                const SizedBox(height: 16),
                GooList(
                  children: widget.model.jobs
                      .map(
                        (job) => GooListItem(
                          title: job.displayName,
                          subtitle: job.stage == 'queued'
                              ? '等待本机引擎'
                              : _jobDescription(job),
                          trailing: _jobTag(job),
                        ),
                      )
                      .toList(growable: false),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Future<void> _showSegmentEditor(
  BuildContext context,
  DesktopWorkstationModel model,
  MeetingWorkspaceSegment segment,
) async {
  final controller = TextEditingController(text: segment.text);
  try {
    await showGooDialog<void>(
      context: context,
      builder: (_) => GooDialog.custom(
        title: '修订转写',
        description:
            '${_duration(segment.startMs)} · ${_speakerLabel(segment)}',
        actions: <GooDialogAction>[
          const GooDialogAction(label: '取消'),
          GooDialogAction(
            label: '保存并标记已核对',
            style: GooDialogActionStyle.primary,
            onPressed: () =>
                model.saveSegment(segmentId: segment.id, text: controller.text),
          ),
        ],
        child: GooInput(
          controller: controller,
          label: '转写文本',
          maxLength: 4000,
          showCounter: true,
        ),
      ),
    );
  } finally {
    controller.dispose();
  }
}

Future<void> _showSpeakerEditor(
  BuildContext context,
  DesktopWorkstationModel model,
  List<MeetingWorkspaceSpeaker> speakers,
) async {
  final controllers = <int, TextEditingController>{
    for (final speaker in speakers)
      speaker.id: TextEditingController(text: speaker.displayName),
  };
  try {
    await showGooDialog<void>(
      context: context,
      builder: (_) => GooDialog.custom(
        title: '批量整理匿名说话人',
        description: '名称只用于本次会议。系统不建立声纹，也不推断真实身份。',
        customContentSizing: GooDialogContentSizing.adaptive,
        actions: <GooDialogAction>[
          const GooDialogAction(label: '取消'),
          if (speakers.length > 1)
            GooDialogAction(
              label: '其余合并到第一位',
              onPressed: () => model.mergeSpeakers(
                targetSpeakerId: speakers.first.id,
                sourceSpeakerIds: speakers
                    .skip(1)
                    .map((item) => item.id)
                    .toSet(),
              ),
            ),
          GooDialogAction(
            label: '保存名称',
            style: GooDialogActionStyle.primary,
            onPressed: () => model.renameSpeakers({
              for (final entry in controllers.entries)
                entry.key: entry.value.text,
            }),
          ),
        ],
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 420),
          child: ListView(
            shrinkWrap: true,
            children: <Widget>[
              for (final speaker in speakers)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: GooInput(
                    controller: controllers[speaker.id],
                    label: speaker.stableKey,
                    maxLength: 120,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  } finally {
    for (final controller in controllers.values) {
      controller.dispose();
    }
  }
}

Future<void> _askAiConsent(
  BuildContext context,
  DesktopWorkstationModel model,
) async {
  final accepted = await showGooDialog<bool>(
    context: context,
    builder: (_) =>
        _AiConsentDialog(providerName: model.aiProviderSettings.displayName),
  );
  await model.generateAiNotes(consentGranted: accepted == true);
}

class _AiConsentDialog extends StatefulWidget {
  const _AiConsentDialog({required this.providerName});

  final String providerName;

  @override
  State<_AiConsentDialog> createState() => _AiConsentDialogState();
}

class _AiConsentDialogState extends State<_AiConsentDialog> {
  bool accepted = false;

  @override
  Widget build(BuildContext context) {
    return GooDialog.custom(
      title: '本次会议云端处理同意',
      description:
          '将发送本次会议的转写文本、时间范围和匿名说话人状态给 ${widget.providerName}。'
          '不会发送音频、密钥、声纹或其他会议。',
      actions: <GooDialogAction>[
        const GooDialogAction(label: '取消', result: false),
        GooDialogAction(
          label: '同意并生成草稿',
          result: true,
          enabled: accepted,
          style: GooDialogActionStyle.primary,
        ),
      ],
      child: GooCheckbox(
        checked: accepted,
        onCheckedChange: (value) => setState(() => accepted = value),
        label: '我同意仅针对本次会议发送上述转写文本',
        isRequired: true,
      ),
    );
  }
}

Future<void> _installLocalModels(
  BuildContext context,
  DesktopWorkstationModel model,
) async {
  if (!model.localProcessingSupported) {
    GooToastScope.of(context).warning('本地离线转写需要 macOS 15.5 或更高版本；其他工作站功能仍可使用。');
    return;
  }
  await model.installModels();
}

Future<void> _showSecretEditor(
  BuildContext context,
  DesktopWorkstationModel model,
) async {
  final controller = TextEditingController();
  try {
    await showGooDialog<void>(
      context: context,
      builder: (_) => GooDialog.custom(
        title: model.aiSecretConfigured
            ? '替换 ${model.aiProviderSettings.displayName} 密钥'
            : '输入 ${model.aiProviderSettings.displayName} 密钥',
        description: '密钥写入 macOS 钥匙串；保存后不会再次显示。',
        actions: <GooDialogAction>[
          const GooDialogAction(label: '取消'),
          GooDialogAction(
            label: '保存到钥匙串',
            style: GooDialogActionStyle.primary,
            onPressed: () => model.replaceAiSecret(controller.text),
          ),
        ],
        child: GooInput(
          controller: controller,
          label: 'API 密钥',
          obscureText: true,
          showVisibilityToggle: false,
          maxLength: 4096,
          autocorrect: false,
          enableSuggestions: false,
        ),
      ),
    );
  } finally {
    controller
      ..clear()
      ..dispose();
  }
}

Future<void> _showAiProviderEditor(
  BuildContext context,
  DesktopWorkstationModel model,
) async {
  final settings = await showGooDialog<DesktopAiProviderSettings>(
    context: context,
    builder: (_) => _AiProviderDialog(initial: model.aiProviderSettings),
  );
  if (settings == null || !context.mounted) return;
  try {
    await model.configureAiProvider(settings);
    if (context.mounted) {
      GooToastScope.of(context).success('AI 提供商配置已保存');
    }
  } on Object {
    if (context.mounted) {
      GooToastScope.of(context).error('配置无效；自定义接口必须使用远程 HTTPS 地址');
    }
  }
}

class _AiProviderDialog extends StatefulWidget {
  const _AiProviderDialog({required this.initial});

  final DesktopAiProviderSettings initial;

  @override
  State<_AiProviderDialog> createState() => _AiProviderDialogState();
}

class _AiProviderDialogState extends State<_AiProviderDialog> {
  late String providerId;
  late final TextEditingController modelController;
  late final TextEditingController endpointController;

  @override
  void initState() {
    super.initState();
    providerId = widget.initial.providerId;
    modelController = TextEditingController(text: widget.initial.modelId);
    endpointController = TextEditingController(text: widget.initial.endpoint);
  }

  @override
  void dispose() {
    modelController.dispose();
    endpointController.dispose();
    super.dispose();
  }

  void _selectProvider(String value) {
    final defaults = switch (value) {
      'openai-compatible' => DesktopAiProviderSettings.openAiCompatible,
      _ => DesktopAiProviderSettings.deepSeek,
    };
    setState(() {
      providerId = value;
      modelController.text = defaults.modelId;
      endpointController.text = defaults.endpoint;
    });
  }

  DesktopAiProviderSettings get _result => DesktopAiProviderSettings(
    providerId: providerId,
    modelId: modelController.text,
    endpoint: endpointController.text,
  );

  @override
  Widget build(BuildContext context) {
    return GooDialog.custom(
      title: '配置会议智能提供商',
      description: '选择只作用于后续任务；运行中的任务保持原 provider/model 快照。',
      customContentSizing: GooDialogContentSizing.adaptive,
      actions: <GooDialogAction>[
        const GooDialogAction(label: '取消'),
        GooDialogAction(
          label: '保存配置',
          result: _result,
          enabled:
              modelController.text.trim().isNotEmpty &&
              endpointController.text.trim().isNotEmpty,
          style: GooDialogActionStyle.primary,
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          GooSegmentedButton<String>(
            value: providerId,
            semanticLabel: '会议智能提供商',
            items: const <GooSegmentedButtonItem<String>>[
              GooSegmentedButtonItem(value: 'deepseek', label: 'DeepSeek'),
              GooSegmentedButtonItem(value: 'openai-compatible', label: '开放接口'),
            ],
            onValueChange: _selectProvider,
          ),
          const SizedBox(height: 12),
          GooInput(
            controller: modelController,
            label: '模型 ID',
            maxLength: 256,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          GooInput(
            controller: endpointController,
            label: '服务地址',
            maxLength: 2048,
            disabled: providerId == 'deepseek',
            autocorrect: false,
            enableSuggestions: false,
            onChanged: (_) => setState(() {}),
          ),
        ],
      ),
    );
  }
}

Future<void> _showInsightEditor(
  BuildContext context,
  DesktopWorkstationModel model,
  MeetingWorkspaceInsight insight,
) async {
  final controller = TextEditingController(text: insight.body);
  try {
    await showGooDialog<void>(
      context: context,
      builder: (_) => GooDialog.custom(
        title: '核对会议笔记',
        description: '${insight.evidenceSegmentIds.length} 条转写证据',
        actions: <GooDialogAction>[
          const GooDialogAction(label: '取消'),
          GooDialogAction(
            label: '保存草稿',
            onPressed: () => model.reviewInsight(
              insightId: insight.id,
              body: controller.text,
              publish: false,
            ),
          ),
          GooDialogAction(
            label: '核对并发布',
            style: GooDialogActionStyle.primary,
            onPressed: () => model.reviewInsight(
              insightId: insight.id,
              body: controller.text,
              publish: true,
            ),
          ),
        ],
        child: GooInput(
          controller: controller,
          label: insight.kind,
          maxLength: 4000,
          showCounter: true,
        ),
      ),
    );
  } finally {
    controller.dispose();
  }
}

String _duration(int milliseconds) {
  final totalSeconds = max(0, milliseconds) ~/ 1000;
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  final seconds = totalSeconds % 60;
  return hours > 0
      ? '${hours.toString().padLeft(2, '0')}:'
            '${minutes.toString().padLeft(2, '0')}:'
            '${seconds.toString().padLeft(2, '0')}'
      : '${minutes.toString().padLeft(2, '0')}:'
            '${seconds.toString().padLeft(2, '0')}';
}

String _speakerLabel(MeetingWorkspaceSegment segment) =>
    switch (segment.speakerState) {
      MeetingWorkspaceSpeakerState.assigned => segment.speakerName ?? '匿名说话人',
      MeetingWorkspaceSpeakerState.overlap => '多人重叠',
      MeetingWorkspaceSpeakerState.unknown => '未知说话人',
    };

String _reviewLabel(MeetingWorkspaceReviewState state) => switch (state) {
  MeetingWorkspaceReviewState.unreviewed => '未核对',
  MeetingWorkspaceReviewState.needsReview => '需核对',
  MeetingWorkspaceReviewState.reviewed => '已核对',
};

String _stateLabel(MeetingWorkspaceProcessingState state) => switch (state) {
  MeetingWorkspaceProcessingState.modelMissing => '缺少模型',
  MeetingWorkspaceProcessingState.installing => '正在安装',
  MeetingWorkspaceProcessingState.queued => '排队中',
  MeetingWorkspaceProcessingState.preparing => '准备中',
  MeetingWorkspaceProcessingState.asr => '正在识别',
  MeetingWorkspaceProcessingState.diarization => '正在分离说话人',
  MeetingWorkspaceProcessingState.partialSuccess => '转写完成，说话人分离待重试',
  MeetingWorkspaceProcessingState.completed => '处理完成',
  MeetingWorkspaceProcessingState.canceling => '正在取消',
  MeetingWorkspaceProcessingState.canceled => '已取消',
  MeetingWorkspaceProcessingState.retryableFailure => '可重试失败',
  MeetingWorkspaceProcessingState.terminalFailure => '终止失败',
  MeetingWorkspaceProcessingState.recoveryUnknown => '恢复状态待确认',
};

GooTag _processingTag(MeetingWorkspaceProcessingState state) {
  final success = state == MeetingWorkspaceProcessingState.completed;
  final warning =
      state == MeetingWorkspaceProcessingState.queued ||
      state == MeetingWorkspaceProcessingState.installing ||
      state == MeetingWorkspaceProcessingState.partialSuccess;
  return GooTag(
    label: _stateLabel(state),
    accent: success
        ? GooTagAccent.green
        : warning
        ? GooTagAccent.orange
        : state == MeetingWorkspaceProcessingState.retryableFailure ||
              state == MeetingWorkspaceProcessingState.terminalFailure
        ? GooTagAccent.red
        : GooTagAccent.blue,
    variant: GooTagVariant.capsule,
  );
}

String _jobDescription(DesktopProcessingJob job) => switch (job.stage) {
  'model_missing' => '缺少准入模型',
  'installing' => '正在安装模型',
  'queued' => '已入队',
  'preparing' => '正在准备隔离工作进程',
  'asr' => '正在本机识别',
  'diarization' => '正在本机分离说话人',
  'partial_success' => '转写已保留，说话人分离可重试',
  'canceling' => '正在终止隔离工作进程',
  'canceled' => '已取消',
  'retryable_failure' => '处理失败，可重试',
  'terminal_failure' => '处理失败，无法自动重试',
  'recovery_unknown' => '应用重启后状态待确认，可安全重试',
  'completed' => '处理完成',
  _ => job.state.name,
};

GooTag _jobTag(DesktopProcessingJob job) => GooTag(
  label: _jobDescription(job),
  accent: job.state == DesktopJobState.completed
      ? job.stage == 'partial_success'
            ? GooTagAccent.orange
            : GooTagAccent.green
      : job.state == DesktopJobState.failed
      ? GooTagAccent.red
      : job.state == DesktopJobState.canceled
      ? GooTagAccent.neutral
      : GooTagAccent.blue,
  variant: GooTagVariant.capsule,
);
