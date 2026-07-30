import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/codex_metrics.dart';
import '../design/codex_theme.dart';
import '../icons/codex_icon.dart';
import 'codex_action.dart';

class CodexMenuItem {
  const CodexMenuItem({
    required this.label,
    this.icon,
    this.shortcut,
    this.danger = false,
    this.selected = false,
    this.enabled = true,
    this.onPressed,
  });

  final String label;
  final CodexIconData? icon;
  final String? shortcut;
  final bool danger;
  final bool selected;
  final bool enabled;
  final VoidCallback? onPressed;
}

Future<void> showCodexMenu({
  required BuildContext context,
  required Rect anchor,
  required List<CodexMenuItem> items,
  double width = 220,
}) async {
  final previousFocus = FocusManager.instance.primaryFocus;
  await Navigator.of(
    context,
  ).push<void>(_CodexMenuRoute(anchor: anchor, items: items, width: width));
  previousFocus?.requestFocus();
}

class _CodexMenuRoute extends PopupRoute<void> {
  _CodexMenuRoute({
    required this.anchor,
    required this.items,
    required this.width,
  });

  final Rect anchor;
  final List<CodexMenuItem> items;
  final double width;

  @override
  Color get barrierColor => Colors.transparent;

  @override
  bool get barrierDismissible => true;

  @override
  String get barrierLabel => 'Dismiss menu';

  @override
  Duration get transitionDuration => CodexMotion.basic;

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) {
    final screen = MediaQuery.sizeOf(context);
    final menuHeight = items.length * 32.0 + 8;
    final left = anchor.left.clamp(6.0, screen.width - width - 6);
    final below = anchor.bottom + 1;
    final top = below + menuHeight <= screen.height - 6
        ? below
        : anchor.top - menuHeight - 1;
    final curved = CurvedAnimation(
      parent: animation,
      curve: CodexMotion.enterSnappy,
      reverseCurve: CodexMotion.standard,
    );

    return Stack(
      children: [
        Positioned(
          left: left,
          top: top.clamp(6, screen.height - menuHeight - 6),
          width: width,
          child: FadeTransition(
            opacity: curved,
            child: ScaleTransition(
              alignment: Alignment.topLeft,
              scale: Tween(begin: .98, end: 1.0).animate(curved),
              child: _CodexMenuSurface(
                key: const ValueKey('codex-menu-surface'),
                items: items,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _CodexMenuSurface extends StatefulWidget {
  const _CodexMenuSurface({required this.items, super.key});

  final List<CodexMenuItem> items;

  @override
  State<_CodexMenuSurface> createState() => _CodexMenuSurfaceState();
}

class _CodexMenuSurfaceState extends State<_CodexMenuSurface> {
  late final List<FocusNode> _focusNodes = [
    for (var index = 0; index < widget.items.length; index++)
      FocusNode(debugLabel: 'Codex menu item $index'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final first = widget.items.indexWhere((item) => item.enabled);
      if (first >= 0) _focusNodes[first].requestFocus();
    });
  }

  @override
  void dispose() {
    for (final node in _focusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      _moveFocus(1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _moveFocus(-1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.space) {
      final index = _focusNodes.indexWhere((node) => node.hasFocus);
      if (index >= 0) _activate(widget.items[index]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _moveFocus(int delta) {
    if (_focusNodes.isEmpty) return;
    var index = _focusNodes.indexWhere((node) => node.hasFocus);
    for (var attempts = 0; attempts < widget.items.length; attempts++) {
      index = (index + delta) % widget.items.length;
      if (index < 0) index += widget.items.length;
      if (widget.items[index].enabled) {
        _focusNodes[index].requestFocus();
        return;
      }
    }
  }

  void _activate(CodexMenuItem item) {
    if (!item.enabled) return;
    Navigator.of(context).pop();
    item.onPressed?.call();
  }

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Focus(
      autofocus: true,
      onKeyEvent: _handleKey,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CodexRadii.xl),
          boxShadow: CodexShadows.extraLarge,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(CodexRadii.xl),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 4, sigmaY: 4),
            child: Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: theme.dropdownSurface,
                borderRadius: BorderRadius.circular(CodexRadii.xl),
                border: Border.all(color: theme.borderHeavy, width: .5),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var index = 0; index < widget.items.length; index++)
                    Semantics(
                      selected: widget.items[index].selected,
                      child: CodexAction(
                        focusNode: _focusNodes[index],
                        selected: widget.items[index].selected,
                        semanticLabel: widget.items[index].label,
                        onPressed: widget.items[index].enabled
                            ? () => _activate(widget.items[index])
                            : null,
                        child: SizedBox(
                          height: 32,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            child: Row(
                              children: [
                                if (widget.items[index].icon != null) ...[
                                  CodexIcon(
                                    widget.items[index].icon!,
                                    size: 15,
                                    color: widget.items[index].danger
                                        ? theme.danger
                                        : theme.iconSecondary,
                                  ),
                                  const SizedBox(width: 8),
                                ],
                                Expanded(
                                  child: Text(
                                    widget.items[index].label,
                                    style: TextStyle(
                                      color: widget.items[index].danger
                                          ? theme.danger
                                          : theme.foreground,
                                      fontSize: CodexTypography.sm,
                                    ),
                                  ),
                                ),
                                if (widget.items[index].shortcut != null)
                                  Text(
                                    widget.items[index].shortcut!,
                                    style: TextStyle(
                                      color: theme.foregroundTertiary,
                                      fontSize: CodexTypography.xs,
                                    ),
                                  ),
                                if (widget.items[index].selected)
                                  CodexIcon(
                                    CodexIconData.check,
                                    size: 14,
                                    color: theme.iconSecondary,
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
