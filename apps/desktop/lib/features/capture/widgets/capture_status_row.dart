import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

class CaptureStatusRow extends StatelessWidget {
  const CaptureStatusRow({
    super.key,
    required this.title,
    required this.description,
    required this.available,
    required this.iconName,
    this.trailing,
    this.level,
  });

  final String title;
  final String description;
  final bool available;
  final GooIconId iconName;
  final Widget? trailing;
  final double? level;

  @override
  Widget build(BuildContext context) {
    return GooListItem(
      title: title,
      subtitle: description,
      leadingIconName: iconName,
      trailing: trailing ?? _statusTrailing(),
    );
  }

  Widget _statusTrailing() {
    final tag = GooTag(
      label: available ? '就绪' : '需处理',
      accent: available ? GooTagAccent.green : GooTagAccent.orange,
      variant: GooTagVariant.capsule,
      semanticLabel: available ? '$title 已就绪' : '$title 需要处理',
    );
    final value = level;
    if (value == null) return tag;
    return SizedBox(
      width: 132,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          tag,
          const SizedBox(height: 6),
          GooProgress(
            value: value.clamp(0, 1),
            status: available
                ? GooProgressStatus.active
                : GooProgressStatus.failed,
            semanticLabel: '$title 电平 ${(value * 100).round()}%',
            liveRegion: true,
          ),
        ],
      ),
    );
  }
}
