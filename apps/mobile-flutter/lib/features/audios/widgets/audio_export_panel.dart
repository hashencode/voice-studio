import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../../transcription/model/transcript_segment_entity.dart';
import '../model/audio_export_selection.dart';
import '../model/audio_time_range.dart';
import '../service/audio_export_service.dart';
import '../utils/audio_time_text.dart';

class AudioExportRequest {
  const AudioExportRequest({required this.format, required this.selection});

  final AudioExportFormat format;
  final AudioExportSelection selection;
}

Future<AudioExportRequest?> showAudioExportPanel(
  BuildContext context, {
  required int durationMs,
  required List<TranscriptSegmentEntity> segments,
}) {
  return showGooPanel<AudioExportRequest>(
    context: context,
    title: '导出转写',
    semanticLabel: '选择转写导出格式和时间范围',
    initialDetentId: 'max',
    builder: (context, controller, scrollController) {
      return SingleChildScrollView(
        controller: scrollController,
        padding: const EdgeInsets.all(16),
        child: _AudioExportPanelBody(
          durationMs: durationMs,
          segments: segments,
          onExport: controller.closeWithResult,
        ),
      );
    },
  );
}

class _AudioExportPanelBody extends StatefulWidget {
  const _AudioExportPanelBody({
    required this.durationMs,
    required this.segments,
    required this.onExport,
  });

  final int durationMs;
  final List<TranscriptSegmentEntity> segments;
  final ValueChanged<AudioExportRequest> onExport;

  @override
  State<_AudioExportPanelBody> createState() => _AudioExportPanelBodyState();
}

class _AudioExportPanelBodyState extends State<_AudioExportPanelBody> {
  late final TextEditingController _startController = TextEditingController(
    text: formatAudioClock(0),
  );
  late final TextEditingController _endController = TextEditingController(
    text: formatAudioClock(widget.durationMs),
  );
  AudioExportFormat _format = AudioExportFormat.text;
  _ExportScope _scope = _ExportScope.all;
  String? _rangeError;
  AudioTimeRange? _range;

  @override
  void dispose() {
    _startController.dispose();
    _endController.dispose();
    super.dispose();
  }

  int get _previewCount {
    final range = _range;
    if (_scope == _ExportScope.range && range == null) return 0;
    return widget.segments
        .where(
          (segment) =>
              range?.intersects(
                startMs: segment.startMs,
                endMs: segment.endMs,
              ) ??
              true,
        )
        .length;
  }

  @override
  Widget build(BuildContext context) {
    final previewCount = _previewCount;
    final canExport = _rangeError == null && previewCount > 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const GooText('格式', variant: GooTextVariant.subtitle),
        const SizedBox(height: 8),
        GooSegmentedButton<AudioExportFormat>(
          value: _format,
          size: GooSegmentedButtonSize.small,
          semanticLabel: '转写导出格式',
          items: const <GooSegmentedButtonItem<AudioExportFormat>>[
            GooSegmentedButtonItem<AudioExportFormat>(
              value: AudioExportFormat.text,
              label: 'TXT',
            ),
            GooSegmentedButtonItem<AudioExportFormat>(
              value: AudioExportFormat.markdown,
              label: 'MD',
            ),
            GooSegmentedButtonItem<AudioExportFormat>(
              value: AudioExportFormat.json,
              label: 'JSON',
            ),
            GooSegmentedButtonItem<AudioExportFormat>(
              value: AudioExportFormat.srt,
              label: 'SRT',
            ),
            GooSegmentedButtonItem<AudioExportFormat>(
              value: AudioExportFormat.vtt,
              label: 'VTT',
            ),
          ],
          onValueChange: (format) => setState(() => _format = format),
        ),
        const SizedBox(height: 6),
        GooText(
          _description(_format),
          variant: GooTextVariant.caption,
          tone: GooTextTone.secondary,
        ),
        const SizedBox(height: 16),
        const GooText('内容范围', variant: GooTextVariant.subtitle),
        const SizedBox(height: 8),
        GooSegmentedButton<_ExportScope>(
          value: _scope,
          size: GooSegmentedButtonSize.small,
          semanticLabel: '转写导出内容范围',
          items: const <GooSegmentedButtonItem<_ExportScope>>[
            GooSegmentedButtonItem<_ExportScope>(
              value: _ExportScope.all,
              label: '全部内容',
            ),
            GooSegmentedButtonItem<_ExportScope>(
              value: _ExportScope.range,
              label: '时间范围',
            ),
          ],
          onValueChange: (scope) {
            setState(() {
              _scope = scope;
              if (scope == _ExportScope.all) {
                _range = null;
                _rangeError = null;
              }
            });
            if (scope == _ExportScope.range) _validateRange();
          },
        ),
        if (_scope == _ExportScope.range) ...<Widget>[
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
        ],
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          label: '所选范围包含 $previewCount 个转写片段',
          child: GooText(
            '将导出 $previewCount 个片段',
            variant: GooTextVariant.caption,
          ),
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: GooButton(
            semanticLabel: canExport ? '导出所选转写内容' : '当前范围无法导出',
            onPressed: canExport ? _submit : null,
            child: const Text('导出所选内容'),
          ),
        ),
      ],
    );
  }

  Widget _buildTimeFields(BuildContext context) {
    final fields = <Widget>[
      GooInput(
        controller: _startController,
        label: '导出开始时间',
        placeholder: 'HH:MM:SS',
        keyboardType: TextInputType.datetime,
        inputFormatters: <TextInputFormatter>[
          FilteringTextInputFormatter.allow(RegExp(r'[0-9:]')),
        ],
        onChanged: (_) => _validateRange(),
      ),
      GooInput(
        controller: _endController,
        label: '导出结束时间',
        placeholder: 'HH:MM:SS',
        keyboardType: TextInputType.datetime,
        inputFormatters: <TextInputFormatter>[
          FilteringTextInputFormatter.allow(RegExp(r'[0-9:]')),
        ],
        onChanged: (_) => _validateRange(),
      ),
    ];
    if (MediaQuery.textScalerOf(context).scale(1) >= 1.5) {
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

  void _validateRange() {
    final startMs = parseAudioClock(_startController.text);
    final endMs = parseAudioClock(_endController.text);
    String? error;
    if (startMs == null || endMs == null) {
      error = '请输入 HH:MM:SS 格式';
    } else if (endMs <= startMs) {
      error = '结束时间必须晚于开始时间';
    } else if (endMs > widget.durationMs) {
      error = '结束时间不能超过音频时长';
    }
    AudioTimeRange? range;
    if (error == null) {
      range = AudioTimeRange(
        startMs: startMs!,
        endMs: endMs!,
        durationMs: widget.durationMs,
      );
      final intersects = widget.segments.any(
        (segment) =>
            range!.intersects(startMs: segment.startMs, endMs: segment.endMs),
      );
      if (!intersects) {
        error = '所选范围没有可导出的转写片段';
        range = null;
      }
    }
    setState(() {
      _rangeError = error;
      _range = range;
    });
  }

  void _submit() {
    if (_rangeError != null || _previewCount == 0) return;
    widget.onExport(
      AudioExportRequest(
        format: _format,
        selection: _scope == _ExportScope.all
            ? const AudioExportSelection.all()
            : AudioExportSelection.range(_range!),
      ),
    );
  }
}

enum _ExportScope { all, range }

String _description(AudioExportFormat format) => switch (format) {
  AudioExportFormat.text => '纯文本正文，段落间保留空行',
  AudioExportFormat.markdown => '标题、时间范围与正文',
  AudioExportFormat.json => '结构化片段、原始时间戳和范围元数据',
  AudioExportFormat.srt => '标准 SRT 字幕，保留原始时间戳',
  AudioExportFormat.vtt => '标准 WebVTT 字幕，保留原始时间戳',
};
