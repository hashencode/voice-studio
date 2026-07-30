import 'package:flutter/material.dart';

import 'design/codex_metrics.dart';
import 'design/codex_theme.dart';
import 'icons/codex_icon.dart';
import 'primitives/codex_action.dart';
import 'primitives/codex_tooltip.dart';

class CodexIconButton extends StatelessWidget {
  const CodexIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.size = 30,
    this.iconSize = 17,
    this.selected = false,
    super.key,
  });

  final CodexIconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final double size;
  final double iconSize;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexTooltip(
      message: tooltip,
      child: CodexAction(
        selected: selected,
        semanticLabel: tooltip,
        toggled: selected,
        onPressed: onPressed,
        borderRadius: CodexRadii.sm,
        child: SizedBox.square(
          dimension: size,
          child: Center(
            child: CodexIcon(
              icon,
              size: iconSize,
              color: onPressed == null
                  ? theme.foregroundTertiary.withValues(alpha: 0.45)
                  : theme.foreground.withValues(alpha: 0.78),
            ),
          ),
        ),
      ),
    );
  }
}

class CodexMark extends StatelessWidget {
  const CodexMark({this.size = 34, super.key});

  final double size;

  @override
  Widget build(BuildContext context) {
    return CodexIcon(
      CodexIconData.openAi,
      size: size,
      color: CodexThemeData.of(context).foreground,
    );
  }
}
