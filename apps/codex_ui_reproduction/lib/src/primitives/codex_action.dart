import 'package:flutter/material.dart';

import '../design/codex_metrics.dart';
import '../design/codex_theme.dart';

class CodexAction extends StatefulWidget {
  const CodexAction({
    required this.child,
    required this.onPressed,
    this.selected = false,
    this.borderRadius = CodexRadii.sm,
    this.padding = EdgeInsets.zero,
    this.focusNode,
    this.semanticLabel,
    this.toggled,
    super.key,
  });

  final Widget child;
  final VoidCallback? onPressed;
  final bool selected;
  final double borderRadius;
  final EdgeInsetsGeometry padding;
  final FocusNode? focusNode;
  final String? semanticLabel;
  final bool? toggled;

  @override
  State<CodexAction> createState() => _CodexActionState();
}

class _CodexActionState extends State<CodexAction> {
  bool _hovered = false;
  bool _pressed = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    final enabled = widget.onPressed != null;
    final background = widget.selected || _pressed
        ? theme.active
        : _hovered && enabled
        ? theme.hover
        : Colors.transparent;

    return Semantics(
      button: true,
      enabled: enabled,
      selected: widget.selected,
      label: widget.semanticLabel,
      toggled: widget.toggled,
      child: FocusableActionDetector(
        focusNode: widget.focusNode,
        enabled: enabled,
        mouseCursor: enabled
            ? SystemMouseCursors.click
            : SystemMouseCursors.basic,
        onShowFocusHighlight: (value) => setState(() => _focused = value),
        actions: <Type, Action<Intent>>{
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              widget.onPressed?.call();
              return null;
            },
          ),
        },
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() {
            _hovered = false;
            _pressed = false;
          }),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onPressed,
            onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
            onTapCancel: enabled
                ? () => setState(() => _pressed = false)
                : null,
            onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
            child: AnimatedContainer(
              duration: CodexMotion.basic,
              curve: CodexMotion.standard,
              padding: widget.padding,
              decoration: BoxDecoration(
                color: background,
                borderRadius: BorderRadius.circular(widget.borderRadius),
                border: _focused
                    ? Border.all(color: theme.accent.withValues(alpha: .7))
                    : null,
              ),
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}
