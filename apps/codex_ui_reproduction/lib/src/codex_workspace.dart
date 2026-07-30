import 'package:flutter/material.dart';

import 'codex_controls.dart';
import 'codex_fixtures.dart';
import 'codex_sidebar.dart';
import 'design/codex_metrics.dart';
import 'design/codex_theme.dart';
import 'icons/codex_icon.dart';
import 'primitives/codex_action.dart';
import 'primitives/codex_menu.dart';
import 'primitives/codex_tooltip.dart';

class CodexWorkspace extends StatelessWidget {
  const CodexWorkspace({
    required this.destination,
    required this.onSearch,
    required this.onSettings,
    required this.taskIndex,
    required this.taskPromptOverride,
    required this.taskFollowUpPrompts,
    required this.onTaskSubmitted,
    required this.onTaskFollowUpSubmitted,
    super.key,
  });

  final CodexDestination destination;
  final VoidCallback onSearch;
  final VoidCallback onSettings;
  final int taskIndex;
  final String? taskPromptOverride;
  final List<String> taskFollowUpPrompts;
  final ValueChanged<String> onTaskSubmitted;
  final ValueChanged<String> onTaskFollowUpSubmitted;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return ColoredBox(
      color: theme.mainSurface,
      child: Column(
        children: [
          _TopBar(
            destination: destination,
            task: codexTaskFixtures[taskIndex],
            onSearch: onSearch,
            onSettings: onSettings,
          ),
          Expanded(
            child: switch (destination) {
              CodexDestination.newTask => _NewTaskView(
                onTaskSubmitted: onTaskSubmitted,
              ),
              CodexDestination.automations => const _CollectionView(
                icon: CodexIconData.clock,
                title: 'Scheduled',
                description:
                    'Create recurring tasks for work you want Codex to handle on a schedule.',
                action: 'New schedule',
              ),
              CodexDestination.skills => const _CollectionView(
                icon: CodexIconData.skill,
                title: 'Skills',
                description:
                    'Use reusable instructions to give Codex specialized workflows.',
                action: 'Create skill',
              ),
              CodexDestination.task => _TaskView(
                task: codexTaskFixtures[taskIndex],
                promptOverride: taskPromptOverride,
                followUpPrompts: taskFollowUpPrompts,
                onFollowUpSubmitted: onTaskFollowUpSubmitted,
              ),
            },
          ),
        ],
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.destination,
    required this.task,
    required this.onSearch,
    required this.onSettings,
  });

  final CodexDestination destination;
  final CodexTaskFixture task;
  final VoidCallback onSearch;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Container(
      height: CodexMetrics.toolbarHeight,
      padding: const EdgeInsets.only(left: 18, right: 10),
      decoration: BoxDecoration(
        border: destination == CodexDestination.task
            ? Border(bottom: BorderSide(color: theme.borderLight))
            : null,
      ),
      child: Row(
        children: [
          if (destination == CodexDestination.task)
            Expanded(
              child: Text(
                task.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.foreground,
                  fontSize: CodexTypography.sm,
                  fontWeight: FontWeight.w600,
                ),
              ),
            )
          else
            const Spacer(),
          CodexIconButton(
            icon: CodexIconData.search,
            tooltip: 'Search',
            onPressed: onSearch,
            size: 28,
            iconSize: 16,
          ),
          const SizedBox(width: 2),
          CodexIconButton(
            icon: CodexIconData.slidersHorizontal,
            tooltip: 'Settings',
            onPressed: onSettings,
            size: 28,
            iconSize: 16,
          ),
        ],
      ),
    );
  }
}

class _NewTaskView extends StatelessWidget {
  const _NewTaskView({required this.onTaskSubmitted});

  final ValueChanged<String> onTaskSubmitted;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Stack(
      children: [
        Positioned.fill(
          bottom: 170,
          child: Center(
            child: Transform.translate(
              offset: const Offset(0, -14),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const CodexMark(size: 38),
                  const SizedBox(height: 18),
                  Text(
                    'What do you want to work on?',
                    style: TextStyle(
                      color: theme.foreground,
                      fontSize: CodexTypography.headingMedium,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: 24,
          child: _Composer(onSubmitted: onTaskSubmitted),
        ),
      ],
    );
  }
}

class _Composer extends StatefulWidget {
  const _Composer({required this.onSubmitted});

  final ValueChanged<String> onSubmitted;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  final _controller = TextEditingController();
  final _modelFocusNode = FocusNode(debugLabel: 'Composer model selector');
  bool _workspaceAttached = true;
  bool _voiceActive = false;
  String _workspace = 'voice2text-flutter';
  String _model = 'GPT-5.2-Codex';
  String _location = 'Local';
  String? _contextLabel;

  @override
  void dispose() {
    _controller.dispose();
    _modelFocusNode.dispose();
    super.dispose();
  }

  void _showModelMenu(BuildContext context) {
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    showCodexMenu(
      context: context,
      anchor: origin & box.size,
      width: 230,
      items: [
        for (final model in const [
          'GPT-5.2-Codex',
          'GPT-5.2-Codex high',
          'GPT-5.1-Codex mini',
        ])
          CodexMenuItem(
            label: model,
            selected: model == _model,
            shortcut: model == 'GPT-5.2-Codex' ? 'Default' : null,
            onPressed: () => setState(() => _model = model),
          ),
      ],
    );
  }

  void _showLocationMenu(BuildContext context) {
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    showCodexMenu(
      context: context,
      anchor: origin & box.size,
      width: 208,
      items: [
        CodexMenuItem(
          label: 'Local',
          icon: CodexIconData.shield,
          selected: _location == 'Local',
          onPressed: () => setState(() => _location = 'Local'),
        ),
        CodexMenuItem(
          label: 'Worktree',
          icon: CodexIconData.gitBranch,
          selected: _location == 'Worktree',
          onPressed: () => setState(() => _location = 'Worktree'),
        ),
      ],
    );
  }

  void _showWorkspaceMenu(BuildContext context) {
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    showCodexMenu(
      context: context,
      anchor: origin & box.size,
      width: 260,
      items: [
        CodexMenuItem(
          label: 'voice2text-flutter',
          icon: CodexIconData.folder,
          selected: _workspace == 'voice2text-flutter',
          onPressed: () => setState(() {
            _workspace = 'voice2text-flutter';
            _workspaceAttached = true;
          }),
        ),
        CodexMenuItem(
          label: 'Open folder...',
          icon: CodexIconData.folder,
          selected: _workspace == 'Open folder...',
          onPressed: () => setState(() {
            _workspace = 'Open folder...';
            _workspaceAttached = true;
          }),
        ),
      ],
    );
  }

  void _showContextMenu(BuildContext context) {
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    showCodexMenu(
      context: context,
      anchor: origin & box.size,
      width: 214,
      items: [
        CodexMenuItem(
          label: 'Add files',
          icon: CodexIconData.plus,
          onPressed: () => setState(() => _contextLabel = 'Files attached'),
        ),
        CodexMenuItem(
          label: 'Add workspace',
          icon: CodexIconData.folder,
          onPressed: () => setState(() => _workspaceAttached = true),
        ),
        CodexMenuItem(
          label: 'Use a skill',
          icon: CodexIconData.skill,
          onPressed: () => setState(() => _contextLabel = 'Skill attached'),
        ),
      ],
    );
  }

  void _submit() {
    final prompt = _controller.text.trim();
    if (prompt.isEmpty) return;
    widget.onSubmitted(prompt);
    _controller.clear();
    setState(() {
      _voiceActive = false;
      _contextLabel = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Align(
      alignment: Alignment.bottomCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: CodexMetrics.composerWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_workspaceAttached)
              Container(
                height: 42,
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.only(left: 12, right: 7),
                decoration: BoxDecoration(
                  color: theme.surfaceUnder,
                  borderRadius: BorderRadius.circular(CodexRadii.lg),
                  border: Border.all(color: theme.border),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Builder(
                        builder: (anchorContext) => CodexAction(
                          key: const ValueKey('composer-workspace-selector'),
                          onPressed: () => _showWorkspaceMenu(anchorContext),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 3),
                            child: Row(
                              children: [
                                CodexIcon(
                                  CodexIconData.folder,
                                  size: 15,
                                  color: theme.iconSecondary,
                                ),
                                const SizedBox(width: 8),
                                Flexible(
                                  child: Text(
                                    _workspace,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: theme.foreground,
                                      fontSize: CodexTypography.sm,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 5),
                                CodexIcon(
                                  CodexIconData.chevronDown,
                                  size: 13,
                                  color: theme.iconTertiary,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    CodexIconButton(
                      icon: CodexIconData.close,
                      tooltip: 'Remove workspace',
                      onPressed: () =>
                          setState(() => _workspaceAttached = false),
                      size: 26,
                      iconSize: 14,
                    ),
                  ],
                ),
              ),
            Container(
              key: const ValueKey('composer'),
              height: 126,
              padding: const EdgeInsets.fromLTRB(14, 10, 9, 8),
              decoration: BoxDecoration(
                color: theme.mainSurface,
                borderRadius: BorderRadius.circular(CodexRadii.xxxl),
                border: Border.all(color: theme.borderHeavy),
                boxShadow: CodexShadows.large,
              ),
              child: Column(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (_contextLabel != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Text(
                              _contextLabel!,
                              style: TextStyle(
                                color: theme.foregroundSecondary,
                                fontSize: CodexTypography.xs,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                        Expanded(
                          child: TextField(
                            key: const ValueKey('composer-input'),
                            controller: _controller,
                            onChanged: (_) => setState(() {}),
                            maxLines: null,
                            cursorColor: theme.accent,
                            style: TextStyle(
                              color: theme.foreground,
                              fontSize: CodexTypography.base,
                              height: 1.4,
                            ),
                            decoration: InputDecoration(
                              isDense: true,
                              border: InputBorder.none,
                              hintText: 'Ask Codex anything',
                              hintStyle: TextStyle(
                                color: theme.foregroundTertiary,
                                fontSize: CodexTypography.base,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Row(
                    children: [
                      Builder(
                        builder: (anchorContext) => CodexIconButton(
                          key: const ValueKey('composer-context'),
                          icon: CodexIconData.plus,
                          tooltip: 'Add files and context',
                          onPressed: () => _showContextMenu(anchorContext),
                          size: 28,
                          iconSize: 17,
                        ),
                      ),
                      const SizedBox(width: 3),
                      Builder(
                        builder: (anchorContext) => _ComposerSelector(
                          key: const ValueKey('composer-model-selector'),
                          label: _model,
                          focusNode: _modelFocusNode,
                          onPressed: () => _showModelMenu(anchorContext),
                        ),
                      ),
                      const SizedBox(width: 2),
                      Builder(
                        builder: (anchorContext) => _ComposerSelector(
                          key: const ValueKey('composer-location-selector'),
                          label: _location,
                          icon: _location == 'Local'
                              ? CodexIconData.shield
                              : CodexIconData.gitBranch,
                          onPressed: () => _showLocationMenu(anchorContext),
                        ),
                      ),
                      const Spacer(),
                      CodexIconButton(
                        key: const ValueKey('composer-voice'),
                        icon: CodexIconData.mic,
                        tooltip: 'Voice input',
                        selected: _voiceActive,
                        onPressed: () =>
                            setState(() => _voiceActive = !_voiceActive),
                        size: 28,
                        iconSize: 17,
                      ),
                      const SizedBox(width: 4),
                      CodexTooltip(
                        message: 'Send',
                        child: CodexAction(
                          key: const ValueKey('composer-send'),
                          borderRadius: CodexRadii.full,
                          onPressed: _controller.text.trim().isEmpty
                              ? null
                              : _submit,
                          child: Container(
                            width: 30,
                            height: 30,
                            decoration: BoxDecoration(
                              color: _controller.text.trim().isEmpty
                                  ? theme.active
                                  : theme.foreground,
                              shape: BoxShape.circle,
                            ),
                            child: Center(
                              child: CodexIcon(
                                CodexIconData.arrowUp,
                                size: 17,
                                color: theme.mainSurface,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ComposerSelector extends StatelessWidget {
  const _ComposerSelector({
    required this.label,
    required this.onPressed,
    this.icon,
    this.focusNode,
    super.key,
  });

  final String label;
  final VoidCallback onPressed;
  final CodexIconData? icon;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexAction(
      focusNode: focusNode,
      onPressed: onPressed,
      child: SizedBox(
        height: 28,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                CodexIcon(icon!, size: 13, color: theme.iconTertiary),
                const SizedBox(width: 5),
              ],
              Text(
                label,
                style: TextStyle(
                  color: theme.foregroundSecondary,
                  fontSize: CodexTypography.xs,
                ),
              ),
              const SizedBox(width: 4),
              CodexIcon(
                CodexIconData.chevronDown,
                size: 13,
                color: theme.iconTertiary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CollectionView extends StatefulWidget {
  const _CollectionView({
    required this.icon,
    required this.title,
    required this.description,
    required this.action,
  });

  final CodexIconData icon;
  final String title;
  final String description;
  final String action;

  @override
  State<_CollectionView> createState() => _CollectionViewState();
}

class _CollectionViewState extends State<_CollectionView> {
  bool _created = false;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CodexIcon(widget.icon, size: 28, color: theme.iconPrimary),
              const SizedBox(height: 16),
              Text(
                widget.title,
                style: TextStyle(
                  color: theme.foreground,
                  fontSize: CodexTypography.headingMedium,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 7),
              Text(
                widget.description,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: theme.foregroundSecondary,
                  height: 1.45,
                  fontSize: CodexTypography.sm,
                ),
              ),
              const SizedBox(height: 20),
              if (_created) ...[
                Container(
                  width: 240,
                  height: 38,
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.symmetric(horizontal: 11),
                  decoration: BoxDecoration(
                    color: theme.surfaceUnder,
                    borderRadius: BorderRadius.circular(CodexRadii.md),
                    border: Border.all(color: theme.border),
                  ),
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '${widget.title} preview',
                    style: TextStyle(
                      color: theme.foregroundSecondary,
                      fontSize: CodexTypography.sm,
                    ),
                  ),
                ),
              ],
              _PrimaryButton(
                label: widget.action,
                onPressed: () => setState(() => _created = true),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TaskView extends StatelessWidget {
  const _TaskView({
    required this.task,
    required this.followUpPrompts,
    required this.onFollowUpSubmitted,
    this.promptOverride,
  });

  final CodexTaskFixture task;
  final List<String> followUpPrompts;
  final ValueChanged<String> onFollowUpSubmitted;
  final String? promptOverride;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Stack(
      children: [
        Positioned.fill(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(32, 28, 32, 190),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                        constraints: const BoxConstraints(maxWidth: 560),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: theme.surfaceUnder,
                          borderRadius: BorderRadius.circular(CodexRadii.xxl),
                        ),
                        child: Text(
                          promptOverride ?? task.prompt,
                          style: TextStyle(
                            color: theme.foreground,
                            fontSize: CodexTypography.base,
                            height: 1.45,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 28),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: CodexMark(size: 20),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                task.response,
                                style: TextStyle(
                                  color: theme.foreground,
                                  fontSize: CodexTypography.base,
                                  height: 1.5,
                                ),
                              ),
                              const SizedBox(height: 14),
                              const _ProgressRow(
                                label: 'Read renderer styles and icon chunks',
                              ),
                              const _ProgressRow(
                                label: 'Rebuild shell and overlay primitives',
                              ),
                              const _ProgressRow(
                                label: 'Verify light and dark states',
                                active: true,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    for (final prompt in followUpPrompts) ...[
                      const SizedBox(height: 26),
                      Align(
                        alignment: Alignment.centerRight,
                        child: Container(
                          constraints: const BoxConstraints(maxWidth: 560),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 10,
                          ),
                          decoration: BoxDecoration(
                            color: theme.surfaceUnder,
                            borderRadius: BorderRadius.circular(CodexRadii.xxl),
                          ),
                          child: Text(
                            prompt,
                            style: TextStyle(
                              color: theme.foreground,
                              fontSize: CodexTypography.base,
                              height: 1.45,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Padding(
                            padding: EdgeInsets.only(top: 2),
                            child: CodexMark(size: 20),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              key: const ValueKey('task-follow-up-response'),
                              'Follow-up added to this local UI preview.',
                              style: TextStyle(
                                color: theme.foreground,
                                fontSize: CodexTypography.base,
                                height: 1.5,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: 24,
          child: _Composer(onSubmitted: onFollowUpSubmitted),
        ),
      ],
    );
  }
}

class _ProgressRow extends StatelessWidget {
  const _ProgressRow({required this.label, this.active = false});

  final String label;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Row(
        children: [
          Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              color: active ? theme.accent : theme.added,
              shape: BoxShape.circle,
            ),
            child: active
                ? null
                : Center(
                    child: CodexIcon(
                      CodexIconData.check,
                      size: 9,
                      color: Colors.white,
                    ),
                  ),
          ),
          const SizedBox(width: 9),
          Text(
            label,
            style: TextStyle(
              color: active ? theme.foreground : theme.foregroundSecondary,
              fontSize: CodexTypography.sm,
            ),
          ),
        ],
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexAction(
      onPressed: onPressed,
      borderRadius: CodexRadii.md,
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        decoration: BoxDecoration(
          color: theme.foreground,
          borderRadius: BorderRadius.circular(CodexRadii.md),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            CodexIcon(CodexIconData.plus, size: 15, color: theme.mainSurface),
            const SizedBox(width: 7),
            Text(
              label,
              style: TextStyle(
                color: theme.mainSurface,
                fontSize: CodexTypography.sm,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
