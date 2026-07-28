import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../../recording/model/recording_annotation_entity.dart';
import '../../transcription/model/transcript_segment_entity.dart';

class TranscriptTimeline extends StatelessWidget {
  const TranscriptTimeline({
    super.key,
    required this.segments,
    required this.currentIndex,
    required this.onSeek,
    required this.onEdit,
    required this.onReviewStateChanged,
    this.annotations = const <RecordingAnnotationEntity>[],
    this.onSeekAnnotation,
    this.controller,
    this.followTargetIndex,
    this.followTargetKey,
  });

  final List<TranscriptSegmentEntity> segments;
  final List<RecordingAnnotationEntity> annotations;
  final int? currentIndex;
  final ValueChanged<TranscriptSegmentEntity> onSeek;
  final ValueChanged<TranscriptSegmentEntity> onEdit;
  final void Function(
    TranscriptSegmentEntity segment,
    TranscriptReviewState state,
  )
  onReviewStateChanged;
  final ValueChanged<RecordingAnnotationEntity>? onSeekAnnotation;
  final ScrollController? controller;
  final int? followTargetIndex;
  final GlobalKey? followTargetKey;

  @override
  Widget build(BuildContext context) {
    if (segments.isEmpty && annotations.isEmpty) {
      return const GooResult.preset(
        preset: GooResultPreset.noContent,
        title: '暂无会议时间线',
        description: '转写完成后，带时间戳的片段会显示在这里。',
      );
    }
    final List<_TimelineEntry>? entries = annotations.isEmpty
        ? null
        : _mergeTimelineEntries(segments, annotations);
    return ListView.builder(
      key: const Key('transcript_timeline'),
      controller: controller,
      itemCount: entries?.length ?? segments.length,
      itemBuilder: (BuildContext context, int timelineIndex) {
        final entry =
            entries?[timelineIndex] ??
            _TimelineEntry.segment(segments[timelineIndex], timelineIndex);
        final annotation = entry.annotationValue;
        if (annotation != null) {
          final isNote = annotation.kind == RecordingAnnotationKind.note;
          return Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: GooList(
              style: GooListStyle.grouped,
              children: <Widget>[
                GooListItem(
                  key: ValueKey<String>('annotation-${annotation.id}'),
                  title: isNote ? annotation.text! : '重点标记',
                  subtitle:
                      '${_clock(annotation.positionMs)} · '
                      '${isNote ? '会中备注' : '会中标记'}',
                  leadingIconName: isNote ? GooIcons.edit : GooIcons.flag,
                  semanticLabel:
                      '${isNote ? '会中备注' : '重点标记'}，'
                      '${_clock(annotation.positionMs)}'
                      '${isNote ? '，${annotation.text}' : ''}',
                  showGuide: onSeekAnnotation != null,
                  onTap: onSeekAnnotation == null
                      ? null
                      : () => onSeekAnnotation!(annotation),
                ),
              ],
            ),
          );
        }

        final segment = entry.segmentValue!;
        final segmentIndex = entry.segmentIndex!;
        final selected = segmentIndex == currentIndex;
        final gapMs = segmentIndex == 0
            ? 0
            : segment.startMs - segments[segmentIndex - 1].endMs;
        final hasParagraphGap = gapMs >= 1500;
        return Column(
          key: segmentIndex == followTargetIndex ? followTargetKey : null,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (hasParagraphGap)
              Semantics(
                key: Key('paragraph_gap_${segment.id}'),
                label: '段落分隔，静音 ${_gapLabel(gapMs)}',
                child: const SizedBox(height: 16),
              ),
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: GooList(
                style: GooListStyle.grouped,
                children: <Widget>[
                  GooListItem(
                    key: ValueKey<int>(segment.id),
                    title: segment.text,
                    subtitle:
                        '${_clock(segment.startMs)} – '
                        '${_clock(segment.endMs)} · '
                        '${_confidenceLabel(segment.confidence)} · '
                        '${_reviewLabel(segment.reviewState)}',
                    selected: selected,
                    semanticLabel:
                        '${selected ? '当前片段，' : ''}'
                        '${_clock(segment.startMs)}，'
                        '${_confidenceLabel(segment.confidence)}，'
                        '${_reviewLabel(segment.reviewState)}，'
                        '${segment.text}',
                    onTap: () => onSeek(segment),
                    trailingMaxWidth: const GooListItemTrailingWidth.fixed(52),
                    trailing: GooMenuAnchor<_TimelineAction>.builder(
                      placement: GooMenuPlacement.bottomRight,
                      fallbackPlacements: const <GooMenuPlacement>[
                        GooMenuPlacement.topRight,
                        GooMenuPlacement.bottomLeft,
                        GooMenuPlacement.topLeft,
                      ],
                      triggerBuilder: (context, openMenu) {
                        return GooButton.icon(
                          iconName: GooIcons.more,
                          size: GooButtonSize.sm,
                          semanticLabel: '管理片段 ${segment.sequenceId + 1}',
                          onPressed: openMenu,
                        );
                      },
                      items: <GooMenuItem<_TimelineAction>>[
                        const GooMenuItem<_TimelineAction>(
                          label: '编辑文本',
                          value: _TimelineAction.edit,
                        ),
                        GooMenuItem<_TimelineAction>(
                          label: '标为待复核',
                          value: _TimelineAction.needsReview,
                          selected:
                              segment.reviewState ==
                              TranscriptReviewState.needsReview,
                        ),
                        GooMenuItem<_TimelineAction>(
                          label: '标为已复核',
                          value: _TimelineAction.reviewed,
                          selected:
                              segment.reviewState ==
                              TranscriptReviewState.reviewed,
                        ),
                        GooMenuItem<_TimelineAction>(
                          label: '重置为未复核',
                          value: _TimelineAction.unreviewed,
                          selected:
                              segment.reviewState ==
                              TranscriptReviewState.unreviewed,
                        ),
                      ],
                      onSelected: (action) {
                        switch (action) {
                          case _TimelineAction.edit:
                            onEdit(segment);
                          case _TimelineAction.needsReview:
                            onReviewStateChanged(
                              segment,
                              TranscriptReviewState.needsReview,
                            );
                          case _TimelineAction.reviewed:
                            onReviewStateChanged(
                              segment,
                              TranscriptReviewState.reviewed,
                            );
                          case _TimelineAction.unreviewed:
                            onReviewStateChanged(
                              segment,
                              TranscriptReviewState.unreviewed,
                            );
                          case null:
                            break;
                        }
                      },
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  static String _clock(int milliseconds) {
    final duration = Duration(milliseconds: milliseconds);
    return '${duration.inMinutes.toString().padLeft(2, '0')}:'
        '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}';
  }

  static String _confidenceLabel(double? confidence) {
    if (confidence == null) return '置信度未知';
    return '置信度 ${(confidence.clamp(0, 1) * 100).round()}%';
  }

  static String _reviewLabel(TranscriptReviewState state) {
    return switch (state) {
      TranscriptReviewState.unreviewed => '未复核',
      TranscriptReviewState.needsReview => '待复核',
      TranscriptReviewState.reviewed => '已复核',
    };
  }

  static String _gapLabel(int gapMs) {
    final seconds = gapMs / 1000;
    return seconds == seconds.roundToDouble()
        ? '${seconds.toInt()} 秒'
        : '${seconds.toStringAsFixed(1)} 秒';
  }
}

class _TimelineEntry {
  const _TimelineEntry._({
    required this.positionMs,
    this.segmentValue,
    this.segmentIndex,
    this.annotationValue,
  });

  factory _TimelineEntry.segment(TranscriptSegmentEntity segment, int index) {
    return _TimelineEntry._(
      positionMs: segment.startMs,
      segmentValue: segment,
      segmentIndex: index,
    );
  }

  factory _TimelineEntry.annotation(RecordingAnnotationEntity annotation) {
    return _TimelineEntry._(
      positionMs: annotation.positionMs,
      annotationValue: annotation,
    );
  }

  final int positionMs;
  final TranscriptSegmentEntity? segmentValue;
  final int? segmentIndex;
  final RecordingAnnotationEntity? annotationValue;

  static int compare(_TimelineEntry left, _TimelineEntry right) {
    final position = left.positionMs.compareTo(right.positionMs);
    if (position != 0) return position;
    if (left.annotationValue != null && right.segmentValue != null) return -1;
    if (left.segmentValue != null && right.annotationValue != null) return 1;
    final leftId = left.annotationValue?.id ?? left.segmentValue!.id;
    final rightId = right.annotationValue?.id ?? right.segmentValue!.id;
    return leftId.compareTo(rightId);
  }
}

List<_TimelineEntry> _mergeTimelineEntries(
  List<TranscriptSegmentEntity> segments,
  List<RecordingAnnotationEntity> annotations,
) {
  final entries = <_TimelineEntry>[];
  var segmentIndex = 0;
  var annotationIndex = 0;
  while (segmentIndex < segments.length ||
      annotationIndex < annotations.length) {
    if (segmentIndex >= segments.length) {
      entries.add(_TimelineEntry.annotation(annotations[annotationIndex++]));
      continue;
    }
    if (annotationIndex >= annotations.length) {
      entries.add(_TimelineEntry.segment(segments[segmentIndex], segmentIndex));
      segmentIndex += 1;
      continue;
    }
    final segmentEntry = _TimelineEntry.segment(
      segments[segmentIndex],
      segmentIndex,
    );
    final annotationEntry = _TimelineEntry.annotation(
      annotations[annotationIndex],
    );
    if (_TimelineEntry.compare(annotationEntry, segmentEntry) <= 0) {
      entries.add(annotationEntry);
      annotationIndex += 1;
    } else {
      entries.add(segmentEntry);
      segmentIndex += 1;
    }
  }
  return entries;
}

enum _TimelineAction { edit, needsReview, reviewed, unreviewed }
