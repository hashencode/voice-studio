import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'codex_controls.dart';
import 'codex_fixtures.dart';
import 'codex_sidebar.dart';
import 'codex_workspace.dart';
import 'design/codex_metrics.dart';
import 'design/codex_theme.dart';
import 'icons/codex_icon.dart';
import 'primitives/codex_action.dart';
import 'primitives/codex_dialog.dart';
import 'primitives/codex_menu.dart';

class CodexApp extends StatefulWidget {
  const CodexApp({super.key});

  @override
  State<CodexApp> createState() => _CodexAppState();
}

class _CodexAppState extends State<CodexApp> {
  ThemeMode _themeMode = ThemeMode.light;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Codex',
      themeMode: _themeMode,
      theme: _theme(Brightness.light),
      darkTheme: _theme(Brightness.dark),
      home: CodexDesktopShell(
        onThemeChanged: (value) {
          setState(() {
            _themeMode = value ? ThemeMode.dark : ThemeMode.light;
          });
        },
        darkMode: _themeMode == ThemeMode.dark,
      ),
    );
  }

  ThemeData _theme(Brightness brightness) {
    final codex = brightness == Brightness.dark
        ? CodexThemeData.dark
        : CodexThemeData.light;
    return ThemeData(
      brightness: brightness,
      useMaterial3: false,
      scaffoldBackgroundColor: codex.mainSurface,
      fontFamily: '.AppleSystemUIFont',
      colorScheme: ColorScheme(
        brightness: brightness,
        primary: codex.accent,
        onPrimary: Colors.white,
        secondary: codex.accent,
        onSecondary: Colors.white,
        error: codex.danger,
        onError: Colors.white,
        surface: codex.mainSurface,
        onSurface: codex.foreground,
      ),
      textTheme: ThemeData(brightness: brightness).textTheme.apply(
        bodyColor: codex.foreground,
        displayColor: codex.foreground,
        fontFamily: '.AppleSystemUIFont',
      ),
      splashFactory: NoSplash.splashFactory,
      hoverColor: Colors.transparent,
      extensions: <ThemeExtension<dynamic>>[codex],
    );
  }
}

class CodexDesktopShell extends StatefulWidget {
  const CodexDesktopShell({
    required this.darkMode,
    required this.onThemeChanged,
    super.key,
  });

  final bool darkMode;
  final ValueChanged<bool> onThemeChanged;

  @override
  State<CodexDesktopShell> createState() => _CodexDesktopShellState();
}

class _CodexDesktopShellState extends State<CodexDesktopShell> {
  bool _collapsed = false;
  bool _searchOpen = false;
  int _selectedTaskIndex = 0;
  String? _submittedPrompt;
  final List<String> _followUpPrompts = [];
  CodexDestination _selected = CodexDestination.newTask;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): _showSearch,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 760;
              final collapsed = compact || _collapsed;
              final sidebarWidth = collapsed
                  ? CodexMetrics.railWidth
                  : CodexMetrics.sidebarWidth(constraints.maxWidth);

              return Row(
                children: [
                  AnimatedContainer(
                    key: const ValueKey('sidebar'),
                    duration: CodexMotion.basic,
                    curve: CodexMotion.standard,
                    width: sidebarWidth,
                    decoration: BoxDecoration(
                      border: Border(
                        right: BorderSide(color: theme.borderLight),
                      ),
                    ),
                    child: CodexSidebar(
                      collapsed: collapsed,
                      selected: _selected,
                      onToggleCollapsed: () {
                        if (!compact) {
                          setState(() => _collapsed = !_collapsed);
                        }
                      },
                      onSelected: (destination) {
                        setState(() => _selected = destination);
                      },
                      onSearch: _showSearch,
                      onSettings: _showSettings,
                      selectedTaskIndex: _selectedTaskIndex,
                      onTaskSelected: (index) {
                        setState(() {
                          _selectedTaskIndex = index;
                          _submittedPrompt = null;
                          _followUpPrompts.clear();
                          _selected = CodexDestination.task;
                        });
                      },
                    ),
                  ),
                  Expanded(
                    child: CodexWorkspace(
                      destination: _selected,
                      onSearch: _showSearch,
                      onSettings: _showSettings,
                      taskIndex: _selectedTaskIndex,
                      taskPromptOverride: _submittedPrompt,
                      taskFollowUpPrompts: _followUpPrompts,
                      onTaskSubmitted: (prompt) {
                        setState(() {
                          _selectedTaskIndex = 0;
                          _submittedPrompt = prompt;
                          _followUpPrompts.clear();
                          _selected = CodexDestination.task;
                        });
                      },
                      onTaskFollowUpSubmitted: (prompt) {
                        setState(() => _followUpPrompts.add(prompt));
                      },
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Future<void> _showSearch() async {
    if (_searchOpen) return;
    _searchOpen = true;
    try {
      await showCodexDialog<void>(
        context: context,
        alignment: const Alignment(0, -.72),
        builder: (_) => _SearchDialog(
          onTaskSelected: (index) {
            setState(() {
              _selectedTaskIndex = index;
              _submittedPrompt = null;
              _followUpPrompts.clear();
              _selected = CodexDestination.task;
            });
          },
        ),
      );
    } finally {
      _searchOpen = false;
    }
  }

  Future<void> _showSettings() {
    return showCodexDialog<void>(
      context: context,
      builder: (_) => _SettingsDialog(
        darkMode: widget.darkMode,
        onThemeChanged: widget.onThemeChanged,
      ),
    );
  }
}

class _SearchDialog extends StatefulWidget {
  const _SearchDialog({required this.onTaskSelected});

  final ValueChanged<int> onTaskSelected;

  @override
  State<_SearchDialog> createState() => _SearchDialogState();
}

class _SearchDialogState extends State<_SearchDialog> {
  final _controller = TextEditingController();
  late final FocusNode _searchFocusNode;
  int _activeResult = 0;

  @override
  void initState() {
    super.initState();
    _searchFocusNode = FocusNode();
  }

  @override
  void dispose() {
    _controller.dispose();
    _searchFocusNode.dispose();
    super.dispose();
  }

  List<(int, CodexTaskFixture)> get _matches {
    final query = _controller.text.trim().toLowerCase();
    return codexTaskFixtures.indexed
        .where((entry) => entry.$2.title.toLowerCase().contains(query))
        .take(query.isEmpty ? 2 : 5)
        .toList(growable: false);
  }

  void _openTask(int index) {
    widget.onTaskSelected(index);
    Navigator.of(context).pop();
  }

  void _moveActiveResult(int delta) {
    final matches = _matches;
    if (matches.isEmpty) return;
    setState(() {
      _activeResult = (_activeResult + delta + matches.length) % matches.length;
    });
  }

  void _activateActiveResult() {
    final matches = _matches;
    if (matches.isEmpty) return;
    _openTask(matches[_activeResult.clamp(0, matches.length - 1)].$1);
  }

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    final query = _controller.text.trim().toLowerCase();
    final matches = _matches;
    if (_activeResult >= matches.length) _activeResult = 0;
    return CodexDialogSurface(
      key: const ValueKey('search-dialog'),
      width: 620,
      radius: CodexRadii.xl,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            height: 54,
            child: Row(
              children: [
                const SizedBox(width: 16),
                CodexIcon(
                  CodexIconData.search,
                  size: 18,
                  color: theme.iconTertiary,
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: CallbackShortcuts(
                    bindings: <ShortcutActivator, VoidCallback>{
                      const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                          _moveActiveResult(1),
                      const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                          _moveActiveResult(-1),
                      const SingleActivator(LogicalKeyboardKey.enter):
                          _activateActiveResult,
                    },
                    child: TextField(
                      key: const ValueKey('search-field'),
                      controller: _controller,
                      focusNode: _searchFocusNode,
                      autofocus: true,
                      cursorColor: theme.accent,
                      onChanged: (_) => setState(() => _activeResult = 0),
                      style: TextStyle(
                        color: theme.foreground,
                        fontSize: CodexTypography.base,
                      ),
                      decoration: InputDecoration(
                        hintText: 'Search tasks',
                        hintStyle: TextStyle(color: theme.foregroundTertiary),
                        border: InputBorder.none,
                        isDense: true,
                      ),
                    ),
                  ),
                ),
                Container(
                  margin: const EdgeInsets.only(right: 12),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: theme.surfaceUnder,
                    borderRadius: BorderRadius.circular(CodexRadii.xs),
                    border: Border.all(color: theme.border),
                  ),
                  child: Text(
                    'esc',
                    style: TextStyle(
                      color: theme.foregroundTertiary,
                      fontSize: CodexTypography.xs,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Divider(height: 1, thickness: .5, color: theme.borderHeavy),
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 112, maxHeight: 330),
            child: matches.isNotEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 14,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          query.isEmpty ? 'Recent' : 'Results',
                          style: TextStyle(
                            color: theme.foregroundTertiary,
                            fontSize: CodexTypography.xs,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        for (final (position, match) in matches.indexed)
                          _SearchResult(
                            title: match.$2.title,
                            workspace: 'voice2text-flutter',
                            selected: position == _activeResult,
                            onPressed: () => _openTask(match.$1),
                          ),
                      ],
                    ),
                  )
                : Center(
                    child: Padding(
                      padding: const EdgeInsets.all(30),
                      child: Text(
                        'No matching tasks',
                        style: TextStyle(
                          color: theme.foregroundTertiary,
                          fontSize: CodexTypography.sm,
                        ),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _SearchResult extends StatelessWidget {
  const _SearchResult({
    required this.title,
    required this.workspace,
    required this.selected,
    required this.onPressed,
  });

  final String title;
  final String workspace;
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
        height: 52,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            children: [
              CodexIcon(
                CodexIconData.newChat,
                size: 16,
                color: theme.iconTertiary,
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: theme.foreground,
                        fontSize: CodexTypography.sm,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      workspace,
                      style: TextStyle(
                        color: theme.foregroundTertiary,
                        fontSize: CodexTypography.xs,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _SettingsSection { general, appearance, notifications, about }

class _SettingsDialog extends StatefulWidget {
  const _SettingsDialog({required this.darkMode, required this.onThemeChanged});

  final bool darkMode;
  final ValueChanged<bool> onThemeChanged;

  @override
  State<_SettingsDialog> createState() => _SettingsDialogState();
}

class _SettingsDialogState extends State<_SettingsDialog> {
  _SettingsSection _section = _SettingsSection.general;
  late bool _darkMode = widget.darkMode;
  String _defaultWorkspace = 'voice2text-flutter';
  String _defaultModel = 'GPT-5.2-Codex';
  String _density = 'Comfortable';
  bool _openLinksInApp = true;
  bool _taskCompletion = true;
  bool _approvalRequests = true;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexDialogSurface(
      key: const ValueKey('settings-dialog'),
      width: 720,
      height: 510,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 190,
            color: theme.surfaceUnder,
            padding: const EdgeInsets.fromLTRB(12, 17, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    'Settings',
                    style: TextStyle(
                      color: theme.foreground,
                      fontSize: CodexTypography.lg,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                _SettingsNav(
                  icon: CodexIconData.settings,
                  label: 'General',
                  selected: _section == _SettingsSection.general,
                  onPressed: () =>
                      setState(() => _section = _SettingsSection.general),
                ),
                _SettingsNav(
                  icon: CodexIconData.slidersHorizontal,
                  label: 'Appearance',
                  selected: _section == _SettingsSection.appearance,
                  onPressed: () =>
                      setState(() => _section = _SettingsSection.appearance),
                ),
                _SettingsNav(
                  icon: CodexIconData.clock,
                  label: 'Notifications',
                  selected: _section == _SettingsSection.notifications,
                  onPressed: () =>
                      setState(() => _section = _SettingsSection.notifications),
                ),
                const Spacer(),
                _SettingsNav(
                  icon: CodexIconData.openAi,
                  label: 'About',
                  selected: _section == _SettingsSection.about,
                  onPressed: () =>
                      setState(() => _section = _SettingsSection.about),
                ),
              ],
            ),
          ),
          Container(width: .5, color: theme.borderHeavy),
          Expanded(
            child: Column(
              children: [
                SizedBox(
                  height: 52,
                  child: Row(
                    children: [
                      const SizedBox(width: 24),
                      Text(
                        _section.label,
                        style: TextStyle(
                          color: theme.foreground,
                          fontSize: CodexTypography.lg,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const Spacer(),
                      CodexIconButton(
                        key: const ValueKey('settings-close'),
                        icon: CodexIconData.close,
                        tooltip: 'Close',
                        onPressed: () => Navigator.of(context).pop(),
                        size: 28,
                        iconSize: 15,
                      ),
                      const SizedBox(width: 12),
                    ],
                  ),
                ),
                Divider(height: .5, thickness: .5, color: theme.borderHeavy),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: CodexMotion.basic,
                    child: switch (_section) {
                      _SettingsSection.general => _GeneralSettings(
                        defaultWorkspace: _defaultWorkspace,
                        defaultModel: _defaultModel,
                        openLinksInApp: _openLinksInApp,
                        onDefaultWorkspaceChanged: (value) =>
                            setState(() => _defaultWorkspace = value),
                        onDefaultModelChanged: (value) =>
                            setState(() => _defaultModel = value),
                        onOpenLinksChanged: (value) =>
                            setState(() => _openLinksInApp = value),
                      ),
                      _SettingsSection.appearance => _AppearanceSettings(
                        darkMode: _darkMode,
                        onThemeChanged: (value) {
                          setState(() => _darkMode = value);
                          widget.onThemeChanged(value);
                        },
                        density: _density,
                        onDensityChanged: (value) =>
                            setState(() => _density = value),
                      ),
                      _SettingsSection.notifications => _NotificationSettings(
                        taskCompletion: _taskCompletion,
                        approvalRequests: _approvalRequests,
                        onTaskCompletionChanged: (value) =>
                            setState(() => _taskCompletion = value),
                        onApprovalRequestsChanged: (value) =>
                            setState(() => _approvalRequests = value),
                      ),
                      _SettingsSection.about => const _AboutSettings(),
                    },
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

extension on _SettingsSection {
  String get label => switch (this) {
    _SettingsSection.general => 'General',
    _SettingsSection.appearance => 'Appearance',
    _SettingsSection.notifications => 'Notifications',
    _SettingsSection.about => 'About',
  };
}

class _SettingsNav extends StatelessWidget {
  const _SettingsNav({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  final CodexIconData icon;
  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: CodexAction(
        selected: selected,
        onPressed: onPressed,
        borderRadius: CodexRadii.md,
        child: SizedBox(
          height: 34,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9),
            child: Row(
              children: [
                CodexIcon(icon, size: 15, color: theme.iconSecondary),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: theme.foreground,
                      fontSize: CodexTypography.sm,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GeneralSettings extends StatelessWidget {
  const _GeneralSettings({
    required this.defaultWorkspace,
    required this.defaultModel,
    required this.openLinksInApp,
    required this.onDefaultWorkspaceChanged,
    required this.onDefaultModelChanged,
    required this.onOpenLinksChanged,
  });

  final String defaultWorkspace;
  final String defaultModel;
  final bool openLinksInApp;
  final ValueChanged<String> onDefaultWorkspaceChanged;
  final ValueChanged<String> onDefaultModelChanged;
  final ValueChanged<bool> onOpenLinksChanged;

  @override
  Widget build(BuildContext context) {
    return _SettingsBody(
      children: [
        _SettingsSelectRow(
          title: 'Default workspace',
          description: 'Where new tasks start by default.',
          value: defaultWorkspace,
          icon: CodexIconData.folder,
          onChanged: onDefaultWorkspaceChanged,
        ),
        const _SettingsDivider(),
        _SettingsSelectRow(
          title: 'Default model',
          description: 'Model used for new tasks.',
          value: defaultModel,
          icon: CodexIconData.openAi,
          onChanged: onDefaultModelChanged,
        ),
        const _SettingsDivider(),
        _SettingsToggleRow(
          title: 'Open links in app',
          description: 'Keep supported links inside Codex.',
          value: openLinksInApp,
          onChanged: onOpenLinksChanged,
        ),
      ],
    );
  }
}

class _AppearanceSettings extends StatelessWidget {
  const _AppearanceSettings({
    required this.darkMode,
    required this.onThemeChanged,
    required this.density,
    required this.onDensityChanged,
  });

  final bool darkMode;
  final ValueChanged<bool> onThemeChanged;
  final String density;
  final ValueChanged<String> onDensityChanged;

  @override
  Widget build(BuildContext context) {
    return _SettingsBody(
      children: [
        _SettingsToggleRow(
          title: 'Dark appearance',
          description: 'Use the dark Codex interface.',
          value: darkMode,
          onChanged: onThemeChanged,
          toggleKey: const ValueKey('dark-mode-toggle'),
        ),
        const _SettingsDivider(),
        _SettingsSelectRow(
          title: 'Interface density',
          description: 'Controls spacing in navigation and task views.',
          value: density,
          icon: CodexIconData.slidersHorizontal,
          onChanged: onDensityChanged,
        ),
      ],
    );
  }
}

class _NotificationSettings extends StatelessWidget {
  const _NotificationSettings({
    required this.taskCompletion,
    required this.approvalRequests,
    required this.onTaskCompletionChanged,
    required this.onApprovalRequestsChanged,
  });

  final bool taskCompletion;
  final bool approvalRequests;
  final ValueChanged<bool> onTaskCompletionChanged;
  final ValueChanged<bool> onApprovalRequestsChanged;

  @override
  Widget build(BuildContext context) {
    return _SettingsBody(
      children: [
        _SettingsToggleRow(
          title: 'Task completion',
          description: 'Notify when Codex finishes a task.',
          value: taskCompletion,
          onChanged: onTaskCompletionChanged,
        ),
        const _SettingsDivider(),
        _SettingsToggleRow(
          title: 'Approval requests',
          description: 'Notify when a task needs your attention.',
          value: approvalRequests,
          onChanged: onApprovalRequestsChanged,
        ),
      ],
    );
  }
}

class _AboutSettings extends StatelessWidget {
  const _AboutSettings();

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Center(
      key: const ValueKey('about-settings'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CodexMark(size: 42),
          const SizedBox(height: 16),
          Text(
            'Codex',
            style: TextStyle(
              color: theme.foreground,
              fontSize: CodexTypography.headingMedium,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            '26.721.81911',
            style: TextStyle(
              color: theme.foregroundTertiary,
              fontSize: CodexTypography.sm,
            ),
          ),
          const SizedBox(height: 20),
          CodexAction(
            onPressed: () => showCodexDialog<void>(
              context: context,
              builder: (_) => const _FeatureDialog(),
            ),
            child: Container(
              height: 34,
              padding: const EdgeInsets.symmetric(horizontal: 13),
              decoration: BoxDecoration(
                color: theme.controlOpaque,
                borderRadius: BorderRadius.circular(CodexRadii.md),
                border: Border.all(color: theme.borderHeavy),
              ),
              alignment: Alignment.center,
              child: Text(
                "What's new",
                style: TextStyle(
                  color: theme.foreground,
                  fontSize: CodexTypography.sm,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FeatureDialog extends StatelessWidget {
  const _FeatureDialog();

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexDialogSurface(
      key: const ValueKey('feature-dialog'),
      width: 480,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 20, 20, 22),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    "What's new in Codex",
                    style: TextStyle(
                      color: theme.foreground,
                      fontSize: CodexTypography.headingSmall,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                CodexIconButton(
                  icon: CodexIconData.close,
                  tooltip: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                  size: 28,
                  iconSize: 15,
                ),
              ],
            ),
            const SizedBox(height: 18),
            const _FeatureRow(
              icon: CodexIconData.newChat,
              title: 'Start from any workspace',
              description: 'Choose a local project and give Codex a task.',
            ),
            const SizedBox(height: 16),
            const _FeatureRow(
              icon: CodexIconData.clock,
              title: 'Schedule recurring work',
              description: 'Run routine tasks automatically on your schedule.',
            ),
            const SizedBox(height: 16),
            const _FeatureRow(
              icon: CodexIconData.skill,
              title: 'Extend Codex with skills',
              description: 'Reuse focused workflows across your projects.',
            ),
          ],
        ),
      ),
    );
  }
}

class _FeatureRow extends StatelessWidget {
  const _FeatureRow({
    required this.icon,
    required this.title,
    required this.description,
  });

  final CodexIconData icon;
  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: theme.surfaceUnder,
            borderRadius: BorderRadius.circular(CodexRadii.md),
          ),
          child: Center(
            child: CodexIcon(icon, size: 17, color: theme.iconSecondary),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: theme.foreground,
                  fontSize: CodexTypography.sm,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                description,
                style: TextStyle(
                  color: theme.foregroundSecondary,
                  fontSize: CodexTypography.xs,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: key,
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
      children: children,
    );
  }
}

class _SettingsDivider extends StatelessWidget {
  const _SettingsDivider();

  @override
  Widget build(BuildContext context) {
    return Divider(
      height: 25,
      thickness: .5,
      color: CodexThemeData.of(context).border,
    );
  }
}

class _SettingsSelectRow extends StatelessWidget {
  const _SettingsSelectRow({
    required this.title,
    required this.description,
    required this.value,
    required this.icon,
    required this.onChanged,
  });

  final String title;
  final String description;
  final String value;
  final CodexIconData icon;
  final ValueChanged<String> onChanged;

  void _showOptions(BuildContext context) {
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    final alternatives = switch (title) {
      'Default workspace' => const ['voice2text-flutter', 'Choose folder...'],
      'Default model' => const [
        'GPT-5.2-Codex',
        'GPT-5.2-Codex high',
        'GPT-5.1-Codex mini',
      ],
      _ => const ['Comfortable', 'Compact'],
    };
    showCodexMenu(
      context: context,
      anchor: origin & box.size,
      width: 184,
      items: [
        for (final option in alternatives)
          CodexMenuItem(
            label: option,
            selected: option == value,
            icon: option == value ? icon : null,
            onPressed: () => onChanged(option),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Row(
      children: [
        Expanded(
          child: _SettingsLabel(title: title, description: description),
        ),
        const SizedBox(width: 24),
        Builder(
          builder: (anchorContext) => CodexAction(
            onPressed: () => _showOptions(anchorContext),
            borderRadius: CodexRadii.md,
            child: Container(
              key: ValueKey('settings-select-$title'),
              width: 184,
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: theme.controlOpaque,
                border: Border.all(color: theme.borderHeavy),
                borderRadius: BorderRadius.circular(CodexRadii.md),
              ),
              child: Row(
                children: [
                  CodexIcon(icon, size: 15, color: theme.iconSecondary),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: theme.foreground,
                        fontSize: CodexTypography.xs,
                      ),
                    ),
                  ),
                  CodexIcon(
                    CodexIconData.chevronDown,
                    size: 14,
                    color: theme.iconTertiary,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SettingsToggleRow extends StatelessWidget {
  const _SettingsToggleRow({
    required this.title,
    required this.description,
    required this.value,
    required this.onChanged,
    this.toggleKey,
  });

  final String title;
  final String description;
  final bool value;
  final ValueChanged<bool> onChanged;
  final Key? toggleKey;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _SettingsLabel(title: title, description: description),
        ),
        const SizedBox(width: 24),
        _CodexToggle(
          key: toggleKey,
          semanticLabel: title,
          value: value,
          onChanged: onChanged,
        ),
      ],
    );
  }
}

class _SettingsLabel extends StatelessWidget {
  const _SettingsLabel({required this.title, required this.description});

  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: TextStyle(
            color: theme.foreground,
            fontSize: CodexTypography.sm,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          description,
          style: TextStyle(
            color: theme.foregroundTertiary,
            fontSize: CodexTypography.xs,
            height: 1.35,
          ),
        ),
      ],
    );
  }
}

class _CodexToggle extends StatelessWidget {
  const _CodexToggle({
    required this.value,
    required this.onChanged,
    required this.semanticLabel,
    super.key,
  });

  final bool value;
  final ValueChanged<bool> onChanged;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final theme = CodexThemeData.of(context);
    return CodexAction(
      onPressed: () => onChanged(!value),
      borderRadius: CodexRadii.full,
      semanticLabel: semanticLabel,
      toggled: value,
      child: AnimatedContainer(
        duration: CodexMotion.basic,
        width: 34,
        height: 20,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: value ? theme.accent : theme.active,
          borderRadius: BorderRadius.circular(CodexRadii.full),
        ),
        alignment: value ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          width: 16,
          height: 16,
          decoration: const BoxDecoration(
            color: Colors.white,
            shape: BoxShape.circle,
            boxShadow: CodexShadows.small,
          ),
        ),
      ),
    );
  }
}
