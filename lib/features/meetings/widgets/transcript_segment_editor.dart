import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../../transcription/model/transcript_segment_entity.dart';

class TranscriptSegmentEditResult {
  const TranscriptSegmentEditResult({
    required this.text,
    required this.markReviewed,
  });

  final String text;
  final bool markReviewed;
}

Future<TranscriptSegmentEditResult?> showTranscriptSegmentEditor({
  required BuildContext context,
  required TranscriptSegmentEntity segment,
}) {
  final draft = ValueNotifier<String>(segment.text);
  final markReviewed = ValueNotifier<bool>(false);
  final result = showGooPanel<TranscriptSegmentEditResult>(
    context: context,
    title: '编辑转写片段',
    showHeaderActions: true,
    initialDetentId: 'default',
    enableBackdropDismiss: false,
    leadingAction: const GooPanelAction<TranscriptSegmentEditResult>(
      label: '取消',
      closesPanelByDefault: true,
    ),
    trailingAction: GooPanelAction<TranscriptSegmentEditResult>(
      label: '保存',
      onPressed: (controller) {
        final value = draft.value.trim();
        if (value.isNotEmpty) {
          controller.closeWithResult(
            TranscriptSegmentEditResult(
              text: value,
              markReviewed: markReviewed.value,
            ),
          );
        }
      },
    ),
    builder: (context, controller, scrollController) {
      return SingleChildScrollView(
        controller: scrollController,
        padding: const EdgeInsets.all(16),
        child: _TranscriptEditorBody(
          initialText: segment.text,
          label:
              '${_clock(segment.startMs)} – ${_clock(segment.endMs)}'
              '（时间范围保持不变）',
          onChanged: (value) => draft.value = value,
          markReviewed: markReviewed,
        ),
      );
    },
  );
  return result.whenComplete(() {
    draft.dispose();
    markReviewed.dispose();
  });
}

class _TranscriptEditorBody extends StatefulWidget {
  const _TranscriptEditorBody({
    required this.initialText,
    required this.label,
    required this.onChanged,
    required this.markReviewed,
  });

  final String initialText;
  final String label;
  final ValueChanged<String> onChanged;
  final ValueNotifier<bool> markReviewed;

  @override
  State<_TranscriptEditorBody> createState() => _TranscriptEditorBodyState();
}

class _TranscriptEditorBodyState extends State<_TranscriptEditorBody> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialText,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        GooTextArea(
          controller: _controller,
          onChanged: widget.onChanged,
          label: widget.label,
          rows: 5,
          autoGrow: true,
          maxLength: 4000,
          showCounter: true,
        ),
        const SizedBox(height: 12),
        GooList(
          style: GooListStyle.grouped,
          children: <Widget>[
            GooListItem(
              title: '保存并标为已复核',
              subtitle: '正文保存成功后同步确认此片段',
              trailing: ValueListenableBuilder<bool>(
                valueListenable: widget.markReviewed,
                builder: (context, value, _) {
                  return GooSwitch(
                    value: value,
                    semanticLabel: '保存时标为已复核',
                    onChanged: (nextValue) {
                      widget.markReviewed.value = nextValue;
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}

String _clock(int milliseconds) {
  final duration = Duration(milliseconds: milliseconds);
  return '${duration.inMinutes.toString().padLeft(2, '0')}:'
      '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}';
}
