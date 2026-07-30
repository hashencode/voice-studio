import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/codex_metrics.dart';
import '../design/codex_theme.dart';

Future<T?> showCodexDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  Alignment alignment = Alignment.center,
}) {
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.transparent,
    transitionDuration: CodexMotion.basic,
    pageBuilder: (context, animation, _) => _CodexDialogPage(
      animation: animation,
      alignment: alignment,
      child: builder(context),
    ),
  );
}

class _CodexDialogPage extends StatelessWidget {
  const _CodexDialogPage({
    required this.animation,
    required this.alignment,
    required this.child,
  });

  final Animation<double> animation;
  final Alignment alignment;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final eased = CurvedAnimation(
      parent: animation,
      curve: CodexMotion.enter,
      reverseCurve: CodexMotion.standard,
    );
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.escape): () =>
            Navigator.of(context).pop(),
      },
      child: Focus(
        autofocus: true,
        child: Stack(
          children: [
            Positioned.fill(
              child: Semantics(
                button: true,
                label: 'Dismiss',
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).pop(),
                  child: ColoredBox(
                    key: const ValueKey('codex-dialog-barrier'),
                    color: CodexThemeData.of(context).scrim,
                  ),
                ),
              ),
            ),
            SafeArea(
              child: Align(
                alignment: alignment,
                child: FadeTransition(
                  opacity: eased,
                  child: ScaleTransition(
                    scale: Tween(begin: .98, end: 1.0).animate(eased),
                    child: child,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CodexDialogSurface extends StatelessWidget {
  const CodexDialogSurface({
    required this.child,
    this.width,
    this.height,
    this.radius = CodexRadii.xxl,
    super.key,
  });

  final Widget child;
  final double? width;
  final double? height;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Material(
      type: MaterialType.transparency,
      child: Container(
        width: width,
        height: height,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: theme.elevatedPrimaryOpaque,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(color: theme.borderHeavy, width: .5),
          boxShadow: const [
            BoxShadow(
              color: Color(0x26000000),
              offset: Offset(0, 18),
              blurRadius: 38,
              spreadRadius: -12,
            ),
            BoxShadow(
              color: Color(0x14000000),
              offset: Offset(0, 4),
              blurRadius: 10,
              spreadRadius: -3,
            ),
          ],
        ),
        child: child,
      ),
    );
  }
}
