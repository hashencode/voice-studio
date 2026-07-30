import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

enum CodexIconData {
  panelLeftOpen('panel_left_open'),
  panelLeftClose('panel_left_close'),
  search('search'),
  newChat('new_chat'),
  settings('settings'),
  clock('clock'),
  blocks('blocks'),
  skill('skill'),
  plus('plus'),
  close('close'),
  mic('mic'),
  folder('folder'),
  gitBranch('git_branch'),
  shield('shield'),
  ellipsis('ellipsis'),
  chevronDown('chevron_down'),
  arrowUp('arrow_up'),
  arrowLeft('arrow_left'),
  arrowRight('arrow_right'),
  slidersHorizontal('sliders_horizontal'),
  check('check'),
  openAi('openai');

  const CodexIconData(this.assetName);

  final String assetName;

  String get assetPath => 'assets/icons/codex/$assetName.svg';
}

class CodexIcon extends StatelessWidget {
  const CodexIcon(
    this.icon, {
    this.size = 16,
    this.color,
    this.semanticLabel,
    super.key,
  });

  final CodexIconData icon;
  final double size;
  final Color? color;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final resolvedColor = color ?? IconTheme.of(context).color;
    return SizedBox.square(
      dimension: size,
      child: SvgPicture.asset(
        icon.assetPath,
        fit: BoxFit.contain,
        colorFilter: resolvedColor == null
            ? null
            : ColorFilter.mode(resolvedColor, BlendMode.srcIn),
        semanticsLabel: semanticLabel,
        excludeFromSemantics: semanticLabel == null,
      ),
    );
  }
}
