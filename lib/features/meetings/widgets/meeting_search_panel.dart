import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_time_range.dart';
import '../service/meeting_search_service.dart';
import '../utils/meeting_time_text.dart';

class MeetingSearchPanel extends StatefulWidget {
  const MeetingSearchPanel({
    super.key,
    required this.durationMs,
    required this.results,
    required this.onSearch,
    required this.onClear,
    required this.onSelect,
    this.searching = false,
  });

  final int durationMs;
  final List<TranscriptSegmentEntity> results;
  final ValueChanged<MeetingTranscriptQuery> onSearch;
  final VoidCallback onClear;
  final ValueChanged<TranscriptSegmentEntity> onSelect;
  final bool searching;

  @override
  State<MeetingSearchPanel> createState() => _MeetingSearchPanelState();
}

class _MeetingSearchPanelState extends State<MeetingSearchPanel> {
  late final TextEditingController _searchController = TextEditingController();
  late final TextEditingController _startController = TextEditingController(
    text: formatMeetingClock(0),
  );
  late final TextEditingController _endController = TextEditingController(
    text: formatMeetingClock(widget.durationMs),
  );
  _ReviewFilter _reviewFilter = _ReviewFilter.all;
  MeetingTranscriptQuery _currentQuery = const MeetingTranscriptQuery();
  bool _timeTouched = false;
  String? _rangeError;

  @override
  void dispose() {
    _searchController.dispose();
    _startController.dispose();
    _endController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GooSearchBar(
          controller: _searchController,
          mode: GooSearchBarMode.activatedInstant,
          placeholder: '搜索当前会议转写',
          showVoiceIcon: false,
          loading: widget.searching,
          debounceMs: 300,
          onSearch: (_) => _emitQuery(),
          onClear: _handleSearchClear,
        ),
        const SizedBox(height: 8),
        GooSegmentedButton<_ReviewFilter>(
          value: _reviewFilter,
          size: GooSegmentedButtonSize.small,
          semanticLabel: '转写复核状态筛选',
          items: const <GooSegmentedButtonItem<_ReviewFilter>>[
            GooSegmentedButtonItem<_ReviewFilter>(
              value: _ReviewFilter.all,
              label: '全部',
            ),
            GooSegmentedButtonItem<_ReviewFilter>(
              value: _ReviewFilter.unreviewed,
              label: '未复核',
            ),
            GooSegmentedButtonItem<_ReviewFilter>(
              value: _ReviewFilter.needsReview,
              label: '待复核',
            ),
            GooSegmentedButtonItem<_ReviewFilter>(
              value: _ReviewFilter.reviewed,
              label: '已复核',
            ),
          ],
          onValueChange: (value) {
            setState(() => _reviewFilter = value);
            _emitQuery();
          },
        ),
        const SizedBox(height: 8),
        _buildTimeFields(context),
        if (_rangeError != null) ...<Widget>[
          const SizedBox(height: 4),
          GooText(
            _rangeError!,
            variant: GooTextVariant.caption,
            tone: GooTextTone.error,
          ),
        ],
        if (!_currentQuery.isEmpty) ...<Widget>[
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              if (_currentQuery.normalizedText.isNotEmpty)
                GooTag(
                  label: '正文 ${_currentQuery.normalizedText}',
                  style: GooTagStyle.assist,
                  accent: GooTagAccent.blue,
                ),
              if (_currentQuery.timeRange case final range?)
                GooTag(
                  label:
                      '时间 ${formatMeetingClock(range.startMs)}–'
                      '${formatMeetingClock(range.endMs)}',
                  style: GooTagStyle.assist,
                  accent: GooTagAccent.orange,
                ),
              if (_currentQuery.reviewState case final state?)
                GooTag(
                  label: '状态 ${_reviewLabel(state)}',
                  style: GooTagStyle.assist,
                  accent: GooTagAccent.green,
                ),
              Semantics(
                liveRegion: true,
                label: '${widget.results.length} 个筛选结果',
                child: GooText(
                  '${widget.results.length} 个结果',
                  variant: GooTextVariant.caption,
                ),
              ),
              GooButton.text(
                semanticLabel: '清除所有转写筛选条件',
                onPressed: _clearAll,
                child: const Text('清除筛选'),
              ),
            ],
          ),
        ],
        if (widget.results.isNotEmpty && !_currentQuery.isEmpty) ...<Widget>[
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 160),
            child: GooList.builder(
              itemCount: widget.results.length,
              itemBuilder: (context, index) {
                final segment = widget.results[index];
                return GooListItem(
                  title: segment.text,
                  subtitle:
                      '${_clock(segment.startMs)} · '
                      '${_reviewLabel(segment.reviewState)}',
                  semanticLabel:
                      '筛选结果 ${index + 1}，'
                      '${_clock(segment.startMs)}，${segment.text}',
                  onTap: () => widget.onSelect(segment),
                );
              },
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildTimeFields(BuildContext context) {
    final fields = <Widget>[
      GooInput(
        controller: _startController,
        label: '开始时间',
        placeholder: 'HH:MM:SS',
        keyboardType: TextInputType.datetime,
        inputFormatters: <TextInputFormatter>[
          FilteringTextInputFormatter.allow(RegExp(r'[0-9:]')),
        ],
        onChanged: (_) => _handleTimeChanged(),
      ),
      GooInput(
        controller: _endController,
        label: '结束时间',
        placeholder: 'HH:MM:SS',
        keyboardType: TextInputType.datetime,
        inputFormatters: <TextInputFormatter>[
          FilteringTextInputFormatter.allow(RegExp(r'[0-9:]')),
        ],
        onChanged: (_) => _handleTimeChanged(),
      ),
    ];
    final textScale = MediaQuery.textScalerOf(context).scale(1);
    if (textScale >= 1.5) {
      return Column(
        children: <Widget>[
          fields.first,
          const SizedBox(height: 8),
          fields.last,
        ],
      );
    }
    return Row(
      children: <Widget>[
        Expanded(child: fields.first),
        const SizedBox(width: 8),
        Expanded(child: fields.last),
      ],
    );
  }

  void _handleTimeChanged() {
    _timeTouched = true;
    _emitQuery();
  }

  void _handleSearchClear() {
    if (_reviewFilter == _ReviewFilter.all && !_timeTouched) {
      setState(() => _currentQuery = const MeetingTranscriptQuery());
      widget.onClear();
      return;
    }
    _emitQuery();
  }

  void _emitQuery() {
    final startMs = parseMeetingClock(_startController.text);
    final endMs = parseMeetingClock(_endController.text);
    final rangeError = _validateRange(startMs, endMs);
    if (rangeError != null) {
      setState(() => _rangeError = rangeError);
      return;
    }
    final range = _timeTouched && (startMs != 0 || endMs != widget.durationMs)
        ? MeetingTimeRange(
            startMs: startMs!,
            endMs: endMs!,
            durationMs: widget.durationMs,
          )
        : null;
    final query = MeetingTranscriptQuery(
      text: _searchController.text,
      timeRange: range,
      reviewState: _reviewFilter.reviewState,
    );
    setState(() {
      _rangeError = null;
      _currentQuery = query;
    });
    if (query.isEmpty) {
      widget.onClear();
    } else {
      widget.onSearch(query);
    }
  }

  String? _validateRange(int? startMs, int? endMs) {
    if (startMs == null || endMs == null) return '请输入 HH:MM:SS 格式';
    if (endMs <= startMs) return '结束时间必须晚于开始时间';
    if (endMs > widget.durationMs) return '结束时间不能超过会议时长';
    return null;
  }

  void _clearAll() {
    _searchController.clear();
    _startController.text = formatMeetingClock(0);
    _endController.text = formatMeetingClock(widget.durationMs);
    setState(() {
      _reviewFilter = _ReviewFilter.all;
      _timeTouched = false;
      _rangeError = null;
      _currentQuery = const MeetingTranscriptQuery();
    });
    widget.onClear();
  }

  static String _clock(int milliseconds) {
    final duration = Duration(milliseconds: milliseconds);
    return '${duration.inMinutes.toString().padLeft(2, '0')}:'
        '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}';
  }

  static String _reviewLabel(TranscriptReviewState state) {
    return switch (state) {
      TranscriptReviewState.unreviewed => '未复核',
      TranscriptReviewState.needsReview => '待复核',
      TranscriptReviewState.reviewed => '已复核',
    };
  }
}

enum _ReviewFilter {
  all(null),
  unreviewed(TranscriptReviewState.unreviewed),
  needsReview(TranscriptReviewState.needsReview),
  reviewed(TranscriptReviewState.reviewed);

  const _ReviewFilter(this.reviewState);

  final TranscriptReviewState? reviewState;
}
