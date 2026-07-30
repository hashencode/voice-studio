import 'package:flutter/material.dart';

import 'codex_controls.dart';
import 'codex_fixtures.dart';
import 'design/codex_metrics.dart';
import 'design/codex_theme.dart';
import 'icons/codex_icon.dart';
import 'primitives/codex_action.dart';
import 'primitives/codex_menu.dart';

enum CodexDestination { newTask, automations, skills, task }

class CodexSidebar extends StatelessWidget {
  const CodexSidebar({
    required this.collapsed,
    required this.selected,
    required this.onToggleCollapsed,
    required this.onSelected,
    required this.onSearch,
    required this.onSettings,
    required this.selectedTaskIndex,
    required this.onTaskSelected,
    super.key,
  });

  final bool collapsed;
  final CodexDestination selected;
  final VoidCallback onToggleCollapsed;
  final ValueChanged<CodexDestination> onSelected;
  final VoidCallback onSearch;
  final VoidCallback onSettings;
  final int selectedTaskIndex;
  final ValueChanged<int> onTaskSelected;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return ColoredBox(
      color: theme.surfaceUnder,
      child: Column(
        children: [
          SizedBox(
            height: CodexMetrics.toolbarHeight,
            child: collapsed
                ? Align(
                    alignment: Alignment.center,
                    child: CodexIconButton(
                      key: const ValueKey('sidebar-toggle'),
                      icon: CodexIconData.panelLeftOpen,
                      tooltip: 'Show sidebar',
                      onPressed: onToggleCollapsed,
                      size: 28,
                      iconSize: 16,
                    ),
                  )
                : Padding(
                    padding: const EdgeInsets.only(left: 70, right: 10),
                    child: Row(
                      children: [
                        CodexIconButton(
                          key: const ValueKey('sidebar-toggle'),
                          icon: CodexIconData.panelLeftClose,
                          tooltip: 'Hide sidebar',
                          onPressed: onToggleCollapsed,
                          size: 28,
                          iconSize: 16,
                        ),
                        const Spacer(),
                        CodexIconButton(
                          icon: CodexIconData.arrowLeft,
                          tooltip: 'Back',
                          onPressed: null,
                          size: 27,
                          iconSize: 16,
                        ),
                        CodexIconButton(
                          icon: CodexIconData.arrowRight,
                          tooltip: 'Forward',
                          onPressed: null,
                          size: 27,
                          iconSize: 16,
                        ),
                      ],
                    ),
                  ),
          ),
          if (collapsed) ...[
            const SizedBox(height: 7),
            const CodexMark(size: 24),
            const SizedBox(height: 13),
            _RailButton(
              icon: CodexIconData.newChat,
              tooltip: 'New chat',
              selected: selected == CodexDestination.newTask,
              onPressed: () => onSelected(CodexDestination.newTask),
            ),
            _RailButton(
              icon: CodexIconData.search,
              tooltip: 'Search',
              onPressed: onSearch,
            ),
            _RailButton(
              icon: CodexIconData.clock,
              tooltip: 'Scheduled',
              selected: selected == CodexDestination.automations,
              onPressed: () => onSelected(CodexDestination.automations),
            ),
            _RailButton(
              icon: CodexIconData.skill,
              tooltip: 'Skills',
              selected: selected == CodexDestination.skills,
              onPressed: () => onSelected(CodexDestination.skills),
            ),
            const Spacer(),
            _RailButton(
              icon: CodexIconData.settings,
              tooltip: 'Settings',
              onPressed: onSettings,
            ),
            const SizedBox(height: 10),
          ] else ...[
            _BrandRow(onSearch: onSearch),
            const SizedBox(height: 6),
            _NavRow(
              key: const ValueKey('nav-new-task'),
              icon: CodexIconData.newChat,
              label: 'New chat',
              selected: selected == CodexDestination.newTask,
              onPressed: () => onSelected(CodexDestination.newTask),
            ),
            _NavRow(
              icon: CodexIconData.search,
              label: 'Search',
              trailing: Text(
                '⌘ K',
                style: TextStyle(
                  fontSize: 11,
                  color: CodexThemeData.of(context).foregroundTertiary,
                ),
              ),
              onPressed: onSearch,
            ),
            _NavRow(
              icon: CodexIconData.clock,
              label: 'Scheduled',
              selected: selected == CodexDestination.automations,
              onPressed: () => onSelected(CodexDestination.automations),
            ),
            _NavRow(
              icon: CodexIconData.skill,
              label: 'Skills',
              selected: selected == CodexDestination.skills,
              onPressed: () => onSelected(CodexDestination.skills),
            ),
            const SizedBox(height: 13),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Recent',
                      style: TextStyle(
                        color: theme.foregroundTertiary,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  Builder(
                    builder: (anchorContext) => CodexIconButton(
                      icon: CodexIconData.ellipsis,
                      tooltip: 'More',
                      onPressed: () {
                        final box =
                            anchorContext.findRenderObject()! as RenderBox;
                        final origin = box.localToGlobal(Offset.zero);
                        showCodexMenu(
                          context: anchorContext,
                          anchor: origin & box.size,
                          width: 180,
                          items: const [
                            CodexMenuItem(label: 'Show all tasks'),
                            CodexMenuItem(label: 'Archived tasks'),
                          ],
                        );
                      },
                      size: 24,
                      iconSize: 15,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 3),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 7),
                itemCount: codexTaskFixtures.length,
                itemBuilder: (context, index) => _TaskRow(
                  key: ValueKey('task-row-$index'),
                  label: codexTaskFixtures[index].title,
                  selected:
                      selected == CodexDestination.task &&
                      index == selectedTaskIndex,
                  onPressed: () => onTaskSelected(index),
                ),
              ),
            ),
            Container(
              margin: const EdgeInsets.fromLTRB(7, 6, 7, 10),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: theme.border)),
              ),
              padding: const EdgeInsets.only(top: 7),
              child: _NavRow(
                icon: CodexIconData.settings,
                label: 'Settings',
                onPressed: onSettings,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _BrandRow extends StatelessWidget {
  const _BrandRow({required this.onSearch});

  final VoidCallback onSearch;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return SizedBox(
      height: 42,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 9, 0),
        child: Row(
          children: [
            Text(
              'Codex',
              style: TextStyle(
                color: theme.foreground,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(width: 2),
            CodexIcon(
              CodexIconData.chevronDown,
              size: 15,
              color: theme.foregroundTertiary,
            ),
            const Spacer(),
            CodexIconButton(
              icon: CodexIconData.search,
              tooltip: 'Search',
              onPressed: onSearch,
              size: 28,
              iconSize: 16,
            ),
          ],
        ),
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  const _RailButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.selected = false,
  });

  final CodexIconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: CodexIconButton(
        icon: icon,
        tooltip: tooltip,
        selected: selected,
        onPressed: onPressed,
        size: 34,
        iconSize: 18,
      ),
    );
  }
}

class _NavRow extends StatelessWidget {
  const _NavRow({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.trailing,
    this.selected = false,
    super.key,
  });

  final CodexIconData icon;
  final String label;
  final VoidCallback onPressed;
  final Widget? trailing;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      child: CodexAction(
        selected: selected,
        onPressed: onPressed,
        borderRadius: CodexRadii.md,
        child: SizedBox(
          height: CodexMetrics.toolbarSmallHeight,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9),
            child: Row(
              children: [
                CodexIcon(
                  icon,
                  size: 17,
                  color: theme.foreground.withValues(alpha: 0.78),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: theme.foreground,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
                trailing ?? const SizedBox.shrink(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    required this.label,
    required this.selected,
    required this.onPressed,
    super.key,
  });

  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexAction(
      selected: selected,
      onPressed: onPressed,
      borderRadius: CodexRadii.md,
      child: SizedBox(
        height: 32,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: theme.foreground.withValues(alpha: 0.82),
                    fontSize: 12.5,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ),
              if (selected)
                CodexIcon(
                  CodexIconData.ellipsis,
                  size: 15,
                  color: theme.foregroundTertiary,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
