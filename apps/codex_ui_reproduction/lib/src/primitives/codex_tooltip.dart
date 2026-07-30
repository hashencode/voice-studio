import 'dart:async';

import 'package:flutter/material.dart';

import '../design/codex_metrics.dart';
import '../design/codex_theme.dart';

class CodexTooltip extends StatefulWidget {
  const CodexTooltip({required this.message, required this.child, super.key});

  final String message;
  final Widget child;

  @override
  State<CodexTooltip> createState() => _CodexTooltipState();
}

class _CodexTooltipState extends State<CodexTooltip> {
  final _link = LayerLink();
  OverlayEntry? _entry;
  Timer? _timer;

  void _scheduleShow() {
    _timer?.cancel();
    _timer = Timer(const Duration(milliseconds: 500), _show);
  }

  void _show() {
    if (!mounted || _entry != null) return;
    final overlay = Overlay.of(context);
    _entry = OverlayEntry(
      builder: (context) => Positioned(
        left: 0,
        top: 0,
        child: IgnorePointer(
          child: CompositedTransformFollower(
            link: _link,
            showWhenUnlinked: false,
            targetAnchor: Alignment.bottomCenter,
            followerAnchor: Alignment.topCenter,
            offset: const Offset(0, 6),
            child: _TooltipSurface(message: widget.message),
          ),
        ),
      ),
    );
    overlay.insert(_entry!);
  }

  void _hide() {
    _timer?.cancel();
    _entry?.remove();
    _entry = null;
  }

  @override
  void dispose() {
    _hide();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: widget.message,
      tooltip: widget.message,
      child: CompositedTransformTarget(
        link: _link,
        child: MouseRegion(
          onEnter: (_) => _scheduleShow(),
          onExit: (_) => _hide(),
          child: widget.child,
        ),
      ),
    );
  }
}

class _TooltipSurface extends StatelessWidget {
  const _TooltipSurface({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.foreground,
        borderRadius: BorderRadius.circular(CodexRadii.sm),
        boxShadow: CodexShadows.large,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        child: Text(
          message,
          style: TextStyle(
            color: theme.mainSurface,
            fontSize: CodexTypography.xs,
            height: 1.2,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
    );
  }
}
