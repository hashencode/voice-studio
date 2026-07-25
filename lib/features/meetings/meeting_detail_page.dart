import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_components/flutter_components.dart';

import '../meeting_intelligence/model/evidence_link_entity.dart';
import '../meeting_intelligence/repository/meeting_intelligence_repository.dart';
import '../meeting_intelligence/service/meeting_intelligence_review_service.dart';
import '../meeting_intelligence/widgets/meeting_intelligence_section.dart';
import '../records/service/meeting_share_service.dart';
import '../transcription/model/transcript_segment_entity.dart';
import 'controller/meeting_review_controller.dart';
import 'model/meeting_record.dart';
import 'service/meeting_export_service.dart';
import 'widgets/meeting_export_panel.dart';
import 'widgets/meeting_player_controls.dart';
import 'widgets/meeting_search_panel.dart';
import 'widgets/transcript_segment_editor.dart';
import 'widgets/transcript_timeline.dart';

class MeetingDetailArguments {
  const MeetingDetailArguments({required this.recordingId});

  final int recordingId;
}

class MeetingDetailPage extends StatefulWidget {
  const MeetingDetailPage({
    super.key,
    required this.recordingId,
    this.controller,
    this.exportService,
    this.shareService,
    this.intelligenceRepository,
    this.intelligenceReviewService,
  });

  final int recordingId;
  final MeetingReviewController? controller;
  final MeetingExportService? exportService;
  final MeetingShareService? shareService;
  final MeetingIntelligenceRepository? intelligenceRepository;
  final MeetingIntelligenceReviewService? intelligenceReviewService;

  @override
  State<MeetingDetailPage> createState() => _MeetingDetailPageState();
}

class _MeetingDetailPageState extends State<MeetingDetailPage> {
  late final MeetingReviewController _controller;
  late final MeetingExportService _exportService;
  late final MeetingShareService _shareService;
  final ScrollController _timelineController = ScrollController();
  final GlobalKey _followTargetKey = GlobalKey();
  int? _lastFollowedIndex;
  int? _followTargetIndex;
  int _followRequestId = 0;

  @override
  void initState() {
    super.initState();
    _controller =
        widget.controller ??
        MeetingReviewController(recordingId: widget.recordingId);
    _exportService = widget.exportService ?? MeetingExportService();
    _shareService = widget.shareService ?? MeetingShareService();
    if (_controller.meeting == null) {
      unawaited(_controller.load());
    }
  }

  @override
  void dispose() {
    _timelineController.dispose();
    if (widget.controller == null) _controller.dispose();
    super.dispose();
  }

  Future<void> _edit(TranscriptSegmentEntity segment) async {
    final result = await showTranscriptSegmentEditor(
      context: context,
      segment: segment,
    );
    if (result == null || !mounted) return;
    try {
      await _controller.saveSegment(
        segmentId: segment.id,
        text: result.text,
        markReviewed: result.markReviewed,
      );
      if (!mounted) return;
      GooToastScope.of(
        context,
      ).success(result.markReviewed ? '转写修改已保存并标为已复核' : '转写修改已保存，可随时撤销');
    } catch (_) {
      if (!mounted) return;
      GooToastScope.of(context).error('无法保存此修改');
    }
  }

  Future<void> _undo() async {
    final undone = await _controller.undoLastEdit();
    if (!mounted) return;
    final toast = GooToastScope.of(context);
    if (undone) {
      toast.success('已撤销最近一次修改');
    } else {
      toast.show(message: '没有可撤销的修改');
    }
  }

  Future<void> _redo() async {
    final redone = await _controller.redoLastEdit();
    if (!mounted) return;
    final toast = GooToastScope.of(context);
    if (redone) {
      toast.success('已重做最近一次撤销');
    } else {
      toast.show(message: '没有可重做的修改');
    }
  }

  Future<void> _updateReviewState(
    TranscriptSegmentEntity segment,
    TranscriptReviewState state,
  ) async {
    try {
      final updated = await _controller.updateReviewState(
        segmentId: segment.id,
        state: state,
      );
      if (!mounted) return;
      if (!updated) {
        GooToastScope.of(context).error('无法更新此片段的复核状态');
        return;
      }
      final label = switch (state) {
        TranscriptReviewState.unreviewed => '未复核',
        TranscriptReviewState.needsReview => '待复核',
        TranscriptReviewState.reviewed => '已复核',
      };
      GooToastScope.of(context).success('已标为$label');
    } catch (_) {
      if (!mounted) return;
      GooToastScope.of(context).error('无法更新此片段的复核状态');
    }
  }

  Future<void> _export() async {
    final meeting = _controller.meeting;
    if (meeting == null) return;
    final request = await showMeetingExportPanel(
      context,
      durationMs: meeting.recording.durationMs,
      segments: meeting.segments,
    );
    if (request == null || !mounted) return;
    try {
      final receipt = await _exportService.export(
        recordingId: meeting.recording.id,
        title: meeting.title,
        segments: meeting.segments,
        format: request.format,
        selection: request.selection,
      );
      await _shareService.share(
        recordingId: meeting.recording.id,
        path: receipt.path,
        displayName: meeting.title,
      );
    } catch (_) {
      if (!mounted) return;
      GooToastScope.of(context).error('导出或分享失败，请稍后重试');
    }
  }

  Future<void> _followCurrentSegment() async {
    final index = _controller.currentSegmentIndex;
    if (!_controller.autoFollow ||
        index == null ||
        index == _lastFollowedIndex ||
        !_timelineController.hasClients) {
      return;
    }
    _lastFollowedIndex = index;
    final requestId = ++_followRequestId;
    setState(() => _followTargetIndex = index);
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        requestId != _followRequestId ||
        !_timelineController.hasClients) {
      return;
    }
    final meeting = _controller.meeting;
    if (meeting == null || index >= meeting.segments.length) return;
    final targetStartMs = meeting.segments[index].startMs;
    final annotationsBeforeTarget = meeting.annotations
        .where((annotation) => annotation.positionMs <= targetStartMs)
        .length;
    final timelineItemCount =
        meeting.segments.length + meeting.annotations.length;
    final timelineIndex = index + annotationsBeforeTarget;
    final fraction = timelineItemCount <= 1
        ? 0.0
        : timelineIndex / (timelineItemCount - 1);
    final estimatedOffset =
        _timelineController.position.maxScrollExtent * fraction;
    final targetOffset = estimatedOffset.clamp(
      0.0,
      _timelineController.position.maxScrollExtent,
    );
    final distance = (targetOffset - _timelineController.offset).abs();
    final nearbyThreshold =
        _timelineController.position.viewportDimension * 3;
    if (distance > nearbyThreshold) {
      // Animating through thousands of variable-height rows makes the sliver
      // lay out intermediate children and can stall a physical device. A
      // direct coarse jump keeps far navigation lazy; ensureVisible below
      // performs the final, short alignment.
      _timelineController.jumpTo(targetOffset);
    } else {
      await _timelineController.animateTo(
        targetOffset,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    }
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted || requestId != _followRequestId) return;
    final targetContext = _followTargetKey.currentContext;
    if (targetContext != null && targetContext.mounted) {
      await Scrollable.ensureVisible(
        targetContext,
        alignment: 0.35,
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOut,
      );
    }
    if (mounted && requestId == _followRequestId) {
      setState(() => _followTargetIndex = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) unawaited(_followCurrentSegment());
        });
        final meeting = _controller.meeting;
        return Scaffold(
          appBar: GooAppBar.secondary(
            title: meeting?.title ?? '会议详情',
            automaticallyImplyLeading: true,
            actions: <GooAppBarIconAction>[
              GooAppBarIconAction(
                iconName: GooIcons.undo,
                tooltip: '撤销编辑',
                semanticLabel: '撤销最近一次转写编辑',
                onPressed: _controller.canUndo ? _undo : null,
              ),
              GooAppBarIconAction(
                iconName: GooIcons.redo,
                tooltip: '重做编辑',
                semanticLabel: '重做最近一次撤销的转写编辑',
                onPressed: _controller.canRedo ? _redo : null,
              ),
              GooAppBarIconAction(
                iconName: GooIcons.download,
                tooltip: '导出',
                semanticLabel: '导出并分享转写',
                onPressed: meeting?.segments.isEmpty != false ? null : _export,
              ),
            ],
          ),
          body: _buildBody(meeting),
        );
      },
    );
  }

  Widget _buildBody(MeetingRecord? meeting) {
    if (_controller.loading && meeting == null) {
      return const Center(
        child: GooSpinner(showLabel: true, label: '正在打开会议', liveRegion: true),
      );
    }
    if (_controller.error != null && meeting == null) {
      return GooResult.preset(
        preset: GooResultPreset.notFound,
        title: '无法打开会议',
        description: _controller.error,
      );
    }
    if (meeting == null) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, constraints) {
        final reviewTools = <Widget>[
          MeetingPlayerControls(
            snapshot: _controller.playback.snapshot,
            onToggle: () => unawaited(_controller.playback.toggle()),
            onSeek: (position) =>
                unawaited(_controller.playback.seekTo(position)),
            onSkip: (delta) => unawaited(_controller.playback.skip(delta)),
            onSpeed: (speed) => unawaited(_controller.playback.setSpeed(speed)),
          ),
          const SizedBox(height: 12),
          MeetingSearchPanel(
            durationMs: meeting.recording.durationMs,
            results: _controller.searchResults,
            searching: _controller.searching,
            onSearch: (query) => unawaited(_controller.search(query)),
            onClear: _controller.clearSearch,
            onSelect: (segment) =>
                unawaited(_controller.seekToSegment(segment)),
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 240),
            child: SingleChildScrollView(
              child: MeetingIntelligenceSection(
                recordingId: meeting.recording.id,
                repository: widget.intelligenceRepository,
                reviewService: widget.intelligenceReviewService,
                onEvidenceSelected: (EvidenceLinkEntity evidence) {
                  final matching = meeting.segments.where(
                    (segment) => segment.id == evidence.segmentId,
                  );
                  if (matching.isNotEmpty) {
                    unawaited(_controller.seekToSegment(matching.first));
                  }
                },
              ),
            ),
          ),
        ];
        final timelineHeader = Row(
          children: <Widget>[
            const GooText('会议时间线', variant: GooTextVariant.subtitle),
            const Spacer(),
            if (!_controller.autoFollow)
              GooButton.text(
                onPressed: _controller.resumeAutoFollow,
                child: const Text('恢复跟随'),
              ),
          ],
        );
        final timeline = Expanded(
          child: NotificationListener<UserScrollNotification>(
            onNotification: (notification) {
              if (notification.direction != ScrollDirection.idle) {
                _controller.suspendAutoFollow();
              }
              return false;
            },
            child: TranscriptTimeline(
              controller: _timelineController,
              segments: meeting.segments,
              annotations: meeting.annotations,
              currentIndex: _controller.currentSegmentIndex,
              onSeek: (segment) =>
                  unawaited(_controller.seekToSegment(segment)),
              onEdit: (segment) => unawaited(_edit(segment)),
              onReviewStateChanged: (segment, state) =>
                  unawaited(_updateReviewState(segment, state)),
              onSeekAnnotation: (annotation) =>
                  unawaited(_controller.seekToAnnotation(annotation)),
              followTargetIndex: _followTargetIndex,
              followTargetKey: _followTargetKey,
            ),
          ),
        );
        final shortWindow =
            constraints.maxHeight < 560 &&
            MediaQuery.textScalerOf(context).scale(1) >= 1.5;
        final content = shortWindow
            ? <Widget>[
                SizedBox(
                  height: constraints.maxHeight * 0.48,
                  child: Semantics(
                    label: '会议复核工具，可上下滚动',
                    explicitChildNodes: true,
                    child: SingleChildScrollView(
                      child: Column(children: reviewTools),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                timelineHeader,
                const SizedBox(height: 8),
                timeline,
              ]
            : <Widget>[
                ...reviewTools,
                const SizedBox(height: 12),
                timelineHeader,
                const SizedBox(height: 8),
                timeline,
              ];
        final width = constraints.maxWidth >= 840 ? 760.0 : double.infinity;
        return Center(
          child: SizedBox(
            width: width,
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: constraints.maxWidth < 600 ? 12 : 24,
                vertical: 12,
              ),
              child: Column(children: content),
            ),
          ),
        );
      },
    );
  }
}
