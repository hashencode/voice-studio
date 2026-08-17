import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../model/audio_template.dart';

class AudioGenerationSelection {
  const AudioGenerationSelection({required this.templateId});

  final AudioTemplateId templateId;
}

Future<AudioGenerationSelection?> showAudioGenerationPanel({
  required BuildContext context,
  required String payloadSummary,
  AudioTemplateId initialTemplate = AudioTemplateId.general,
}) {
  return showGooPanel<AudioGenerationSelection>(
    context: context,
    title: '生成音频纪要',
    semanticLabel: '选择音频纪要模板和发送范围',
    builder: (context, controller, scrollController) {
      var selected = initialTemplate;
      return StatefulBuilder(
        builder: (context, setState) {
          return ListView(
            controller: scrollController,
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              const GooText('模板', variant: GooTextVariant.subtitle),
              const SizedBox(height: 8),
              GooList(
                style: GooListStyle.grouped,
                children: AudioTemplate.known
                    .map(
                      (template) => GooListItem(
                        title: template.label,
                        subtitle: template.description,
                        selected: template.id == selected,
                        onTap: () => setState(() => selected = template.id),
                      ),
                    )
                    .toList(growable: false),
              ),
              const SizedBox(height: 16),
              const GooText('本次范围', variant: GooTextVariant.subtitle),
              const SizedBox(height: 8),
              GooList(
                style: GooListStyle.grouped,
                children: <Widget>[
                  GooListItem(
                    title: '当前音频的完整稳定转写',
                    subtitle: payloadSummary,
                    selected: true,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              const GooText(
                '下一步仍会展示提供商、模型和实际发送内容；只有再次明确同意才会创建云端请求。',
                variant: GooTextVariant.caption,
              ),
              const SizedBox(height: 24),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  GooButton(
                    variant: GooButtonVariant.secondary,
                    onPressed: controller.close,
                    child: const Text('取消'),
                  ),
                  GooButton(
                    onPressed: () => controller.closeWithResult(
                      AudioGenerationSelection(templateId: selected),
                    ),
                    child: const Text('下一步'),
                  ),
                ],
              ),
            ],
          );
        },
      );
    },
  );
}
