import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../../app/theme/theme_mode_controller.dart';
import 'model/transcription_model_descriptor.dart';
import 'repository/app_settings_repository.dart';
import '../shared/widgets/build_info_footer.dart';
import 'model/app_settings.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, this.repository});

  final AppSettingsRepository? repository;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final AppSettingsRepository _repository;

  bool _loading = true;
  String _modelId = 'paraformer-zh';
  bool _autoTranscribe = true;
  bool _enablePunctuation = true;
  bool _isDarkMode = false;
  int? _recentlyDeletedRetentionDays;
  AppSettings? _loadedSettings;

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? AppSettingsRepository();
    _load();
  }

  Future<void> _load() async {
    final AppSettings settings = await _repository.load();
    final TranscriptionModelDescriptor selectedModel =
        TranscriptionModelDescriptor.findById(settings.modelId) ??
        TranscriptionModelDescriptor.defaultModel();
    if (!mounted) return;
    setState(() {
      _modelId = selectedModel.selectable
          ? selectedModel.id
          : TranscriptionModelDescriptor.defaultModel().id;
      _autoTranscribe = settings.autoTranscribe;
      _enablePunctuation =
          selectedModel.punctuationReady && settings.enablePunctuation;
      _isDarkMode = settings.isDarkMode;
      _recentlyDeletedRetentionDays = settings.recentlyDeletedRetentionDays;
      _loadedSettings = settings;
      _loading = false;
    });
  }

  Future<void> _save() async {
    final loadedSettings = _loadedSettings;
    if (loadedSettings == null) return;
    final AppThemeModeController themeController = AppThemeModeScope.of(
      context,
    );
    final updatedSettings = loadedSettings.copyWith(
      modelId: _modelId,
      autoTranscribe: _autoTranscribe,
      enablePunctuation: _enablePunctuation,
      isDarkMode: _isDarkMode,
      recentlyDeletedRetentionDays: _recentlyDeletedRetentionDays,
      clearRecentlyDeletedRetention: _recentlyDeletedRetentionDays == null,
    );
    await _repository.save(updatedSettings);
    await themeController.setDarkMode(_isDarkMode);
    if (!mounted) return;
    _loadedSettings = updatedSettings;
    GooSnackbarScope.maybeOf(context)?.show(message: '设置已保存');
  }

  Future<void> _chooseRetentionPolicy() async {
    final int? selected = await showGooPanel<int>(
      context: context,
      title: '最近删除自动清理',
      semanticLabel: '选择最近删除自动清理期限',
      builder:
          (
            BuildContext context,
            GooPanelController<int> controller,
            ScrollController scrollController,
          ) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                const GooText(
                  '只会永久清理已在“最近删除”中达到期限的会议。默认关闭，不影响正常会议。',
                  variant: GooTextVariant.body,
                ),
                const SizedBox(height: 16),
                GooList(
                  style: GooListStyle.grouped,
                  children: <Widget>[
                    for (final option in const <int>[0, 7, 30, 90])
                      GooListItem(
                        title: option == 0 ? '关闭' : '保留 $option 天',
                        selected:
                            (_recentlyDeletedRetentionDays ?? 0) == option,
                        semanticLabel:
                            '${option == 0 ? '关闭自动清理' : '保留 $option 天'}'
                            '${(_recentlyDeletedRetentionDays ?? 0) == option ? '，当前选中' : ''}',
                        onTap: () => controller.closeWithResult(option),
                      ),
                  ],
                ),
              ],
            );
          },
    );
    if (!mounted || selected == null) return;
    setState(() {
      _recentlyDeletedRetentionDays = selected == 0 ? null : selected;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Scaffold(
        appBar: const GooAppBar.secondary(title: '设置'),
        body: const Center(
          child: GooSpinner(semanticLabel: '正在加载设置', liveRegion: true),
        ),
        bottomNavigationBar: const SafeArea(
          top: false,
          child: BuildInfoFooter(),
        ),
      );
    }

    return Scaffold(
      appBar: const GooAppBar.secondary(title: '设置'),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          const GooText('识别模型', variant: GooTextVariant.subtitle),
          const SizedBox(height: 8),
          GooList(
            style: GooListStyle.grouped,
            children: TranscriptionModelDescriptor.known
                .map(_buildModelItem)
                .toList(),
          ),
          const SizedBox(height: 16),
          GooList(
            style: GooListStyle.grouped,
            children: <Widget>[
              GooListItem(
                title: '停止录音后自动转写',
                subtitle: '关闭后只保存录音，不自动进入转写流程',
                trailing: GooSwitch(
                  value: _autoTranscribe,
                  onChanged: (bool value) {
                    setState(() {
                      _autoTranscribe = value;
                    });
                  },
                ),
              ),
              GooListItem(
                title: '自动恢复标点',
                subtitle: '使用本地模型处理新转写，不会上传会议内容',
                trailing: GooSwitch(
                  value: _enablePunctuation,
                  onChanged: (bool value) {
                    setState(() {
                      _enablePunctuation = value;
                    });
                  },
                ),
              ),
              GooListItem(
                title: '深色模式',
                subtitle: '切换全局界面的明暗主题',
                trailing: GooSwitch(
                  value: _isDarkMode,
                  onChanged: (bool value) {
                    setState(() {
                      _isDarkMode = value;
                    });
                  },
                ),
              ),
              GooListItem(
                title: '最近删除自动清理',
                subtitle: _recentlyDeletedRetentionDays == null
                    ? '已关闭；不会自动永久删除会议'
                    : '保留 $_recentlyDeletedRetentionDays 天；只清理最近删除',
                showGuide: true,
                semanticLabel:
                    '最近删除自动清理，'
                    '${_recentlyDeletedRetentionDays == null ? '已关闭' : '保留 $_recentlyDeletedRetentionDays 天'}',
                onTap: _chooseRetentionPolicy,
              ),
              GooListItem(
                title: '帮助与反馈',
                subtitle: '离线指南、数据边界和安全诊断分享',
                leadingIconName: GooIcons.helpAndFeedback,
                showGuide: true,
                onTap: () => Navigator.of(context).pushNamed('/help'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: GooButton(onPressed: _save, child: const Text('保存设置')),
          ),
        ],
      ),
      bottomNavigationBar: const SafeArea(top: false, child: BuildInfoFooter()),
    );
  }

  Widget _buildModelItem(TranscriptionModelDescriptor descriptor) {
    final bool selected = descriptor.id == _modelId;
    final String capabilities = <String>[
      if (descriptor.offlineReady) '离线可用',
      if (descriptor.punctuationReady) '离线标点',
      if (!descriptor.punctuationReady) '标点未开放',
      if (!descriptor.denoiseReady) '降噪未开放',
    ].join(' · ');

    return GooListItem(
      title: descriptor.name,
      subtitle: '${descriptor.description}\n$capabilities',
      disabled: !descriptor.selectable,
      selected: selected,
      trailing: selected
          ? GooIcon(
              id: GooIcons.done,
              color: Theme.of(context).colorScheme.primary,
            )
          : null,
      onTap: descriptor.selectable
          ? () {
              setState(() {
                _modelId = descriptor.id;
              });
            }
          : null,
    );
  }
}
