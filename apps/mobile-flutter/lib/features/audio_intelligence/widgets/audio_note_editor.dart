import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../model/audio_insight_entity.dart';

class AudioNoteEditResult {
  const AudioNoteEditResult({
    required this.body,
    this.actionOwner,
    this.actionDueAtMs,
    this.clearActionOwner = false,
    this.clearActionDueAt = false,
  });

  final String body;
  final String? actionOwner;
  final int? actionDueAtMs;
  final bool clearActionOwner;
  final bool clearActionDueAt;
}

Future<AudioNoteEditResult?> showAudioNoteEditor({
  required BuildContext context,
  required AudioInsightEntity insight,
}) {
  return showGooPanel<AudioNoteEditResult>(
    context: context,
    title: '编辑${_kindLabel(insight.kind)}',
    semanticLabel: '编辑音频纪要条目',
    builder: (context, controller, scrollController) {
      return _AudioNoteEditorBody(
        insight: insight,
        scrollController: scrollController,
        onCancel: controller.close,
        onSave: controller.closeWithResult,
      );
    },
  );
}

class _AudioNoteEditorBody extends StatefulWidget {
  const _AudioNoteEditorBody({
    required this.insight,
    required this.scrollController,
    required this.onCancel,
    required this.onSave,
  });

  final AudioInsightEntity insight;
  final ScrollController scrollController;
  final VoidCallback onCancel;
  final ValueChanged<AudioNoteEditResult> onSave;

  @override
  State<_AudioNoteEditorBody> createState() => _AudioNoteEditorBodyState();
}

class _AudioNoteEditorBodyState extends State<_AudioNoteEditorBody> {
  late final TextEditingController _bodyController;
  late final TextEditingController _ownerController;
  GooDateTimePickerValue? _dueDate;

  @override
  void initState() {
    super.initState();
    _bodyController = TextEditingController(text: widget.insight.body);
    _ownerController = TextEditingController(
      text: widget.insight.actionOwner ?? '',
    );
    final dueAt = widget.insight.actionDueAtMs;
    if (dueAt != null) {
      final date = DateTime.fromMillisecondsSinceEpoch(dueAt).toLocal();
      _dueDate = GooDateTimePickerValue(
        date: DateTime(date.year, date.month, date.day),
        time: const TimeOfDay(hour: 0, minute: 0),
      );
    }
  }

  @override
  void dispose() {
    _bodyController.dispose();
    _ownerController.dispose();
    super.dispose();
  }

  void _save() {
    final body = _bodyController.text.trim();
    if (body.isEmpty) {
      GooToastScope.of(context).error('条目正文不能为空');
      return;
    }
    final owner = _ownerController.text.trim();
    final date = _dueDate?.date;
    widget.onSave(
      AudioNoteEditResult(
        body: body,
        actionOwner: owner.isEmpty ? null : owner,
        actionDueAtMs: date == null
            ? null
            : DateTime(date.year, date.month, date.day).millisecondsSinceEpoch,
        clearActionOwner:
            widget.insight.kind == AudioInsightKind.action && owner.isEmpty,
        clearActionDueAt:
            widget.insight.kind == AudioInsightKind.action && date == null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      controller: widget.scrollController,
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        GooTextArea(
          controller: _bodyController,
          label: '正文',
          placeholder: '输入音频纪要内容',
          maxLength: 4000,
          showCounter: true,
          autoGrow: true,
          minHeight: 152,
        ),
        if (widget.insight.kind == AudioInsightKind.action) ...<Widget>[
          const SizedBox(height: 12),
          GooInput(
            controller: _ownerController,
            label: '负责人',
            placeholder: '留空则保持待确认',
            showClearButton: true,
          ),
          const SizedBox(height: 12),
          GooDateTimePickerFormField(
            mode: GooDateTimePickerMode.date,
            initialValue: _dueDate,
            label: '截止日期',
            placeholder: '留空则保持待确认',
            allowClear: true,
            onChanged: (value) => _dueDate = value,
          ),
        ],
        const SizedBox(height: 24),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            GooButton(
              variant: GooButtonVariant.secondary,
              onPressed: widget.onCancel,
              child: const Text('取消'),
            ),
            GooButton(onPressed: _save, child: const Text('保存修改')),
          ],
        ),
      ],
    );
  }
}

String _kindLabel(AudioInsightKind kind) => switch (kind) {
  AudioInsightKind.title => '标题建议',
  AudioInsightKind.summary => '摘要',
  AudioInsightKind.summaryKeyPoint => '要点摘要',
  AudioInsightKind.summaryDetailed => '详细纪要',
  AudioInsightKind.topic => '议题',
  AudioInsightKind.decision => '决策',
  AudioInsightKind.action => '行动项',
  AudioInsightKind.risk => '风险',
  AudioInsightKind.unresolved => '待确认事项',
};
