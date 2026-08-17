import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../../app/theme/theme_mode_controller.dart';
import '../audio_intelligence/service/audio_api_secret_store.dart';
import '../audio_intelligence/service/audio_intelligence_provider.dart';
import 'model/transcription_model_descriptor.dart';
import 'repository/app_settings_repository.dart';
import '../shared/widgets/build_info_footer.dart';
import 'model/app_settings.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, this.repository, this.secretStore});

  final AppSettingsRepository? repository;
  final AudioApiSecretStore? secretStore;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final AppSettingsRepository _repository;
  late final AudioApiSecretStore _secretStore;

  bool _loading = true;
  String _modelId = 'paraformer-zh';
  bool _autoTranscribe = true;
  bool _enablePunctuation = true;
  bool _isDarkMode = false;
  int? _recentlyDeletedRetentionDays;
  AudioProcessingLocation _audioProcessingLocation =
      AudioProcessingLocation.onDevice;
  String _audioAiProviderId = 'deepseek';
  bool _audioAiSecretConfigured = false;
  final TextEditingController _audioAiModelController = TextEditingController();
  final TextEditingController _audioApiSecretController =
      TextEditingController();
  AppSettings? _loadedSettings;

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? AppSettingsRepository();
    _secretStore = widget.secretStore ?? const AudioApiSecretStore();
    _load();
  }

  @override
  void dispose() {
    _audioAiModelController.dispose();
    _audioApiSecretController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final AppSettings settings = await _repository.load();
    var secretConfigured = settings.audioAiSecretConfigured;
    if (secretConfigured && settings.audioAiProviderId != null) {
      secretConfigured = await _secretStore
          .hasSecret(settings.audioAiProviderId!)
          .catchError((_) => false);
    }
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
      _audioProcessingLocation = settings.audioProcessingLocation;
      _audioAiProviderId = settings.audioAiProviderId ?? 'deepseek';
      _audioAiModelController.text =
          settings.audioAiModelId ?? 'deepseek-v4-flash';
      _audioAiSecretConfigured = secretConfigured;
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
    var secretConfigured = _audioAiSecretConfigured;
    final enteredSecret = _audioApiSecretController.text.trim();
    if (enteredSecret.isNotEmpty) {
      try {
        await _secretStore.save(
          providerId: _audioAiProviderId,
          secret: enteredSecret,
        );
        secretConfigured = true;
        _audioApiSecretController.clear();
      } catch (_) {
        if (!mounted) return;
        GooToastScope.of(context).error('云端密钥无法安全保存');
        return;
      }
    }
    final updatedSettings = loadedSettings.copyWith(
      modelId: _modelId,
      autoTranscribe: _autoTranscribe,
      enablePunctuation: _enablePunctuation,
      isDarkMode: _isDarkMode,
      recentlyDeletedRetentionDays: _recentlyDeletedRetentionDays,
      clearRecentlyDeletedRetention: _recentlyDeletedRetentionDays == null,
      audioProcessingLocation: _audioProcessingLocation,
      audioAiProviderId: _audioAiProviderId,
      audioAiModelId: _audioAiModelController.text.trim(),
      audioAiSecretConfigured: secretConfigured,
    );
    await _repository.save(updatedSettings);
    await themeController.setDarkMode(_isDarkMode);
    if (!mounted) return;
    _loadedSettings = updatedSettings;
    _audioAiSecretConfigured = secretConfigured;
    GooSnackbarScope.maybeOf(context)?.show(message: '设置已保存');
  }

  Future<void> _chooseAudioProcessingLocation() async {
    final selected = await showGooPanel<AudioProcessingLocation>(
      context: context,
      title: 'AI 处理位置',
      semanticLabel: '选择音频智能处理位置',
      builder:
          (
            BuildContext context,
            GooPanelController<AudioProcessingLocation> controller,
            ScrollController scrollController,
          ) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                const GooText(
                  '只有选择云端直连并在单次生成前确认，音频文本才会离开设备。PC 配对尚未开放。',
                  variant: GooTextVariant.body,
                ),
                const SizedBox(height: 16),
                GooList(
                  style: GooListStyle.grouped,
                  children: <Widget>[
                    GooListItem(
                      title: '本机',
                      subtitle: '不上传音频内容；本地音频智能模型尚未配置',
                      selected:
                          _audioProcessingLocation ==
                          AudioProcessingLocation.onDevice,
                      onTap: () => controller.closeWithResult(
                        AudioProcessingLocation.onDevice,
                      ),
                    ),
                    GooListItem(
                      title: '云端直连',
                      subtitle: '使用用户自己的 DeepSeek 账户和密钥',
                      selected:
                          _audioProcessingLocation ==
                          AudioProcessingLocation.cloudDirect,
                      onTap: () => controller.closeWithResult(
                        AudioProcessingLocation.cloudDirect,
                      ),
                    ),
                  ],
                ),
              ],
            );
          },
    );
    if (!mounted || selected == null) return;
    setState(() {
      _audioProcessingLocation = selected;
    });
  }

  Future<void> _deleteAudioApiSecret() async {
    final loadedSettings = _loadedSettings;
    if (loadedSettings == null) return;
    try {
      await _secretStore.delete(_audioAiProviderId);
      final updated = loadedSettings.copyWith(audioAiSecretConfigured: false);
      await _repository.save(updated);
      if (!mounted) return;
      setState(() {
        _audioAiSecretConfigured = false;
        _audioApiSecretController.clear();
        _loadedSettings = updated;
      });
      GooToastScope.of(context).success('云端密钥已删除');
    } catch (_) {
      if (!mounted) return;
      GooToastScope.of(context).error('云端密钥无法删除');
    }
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
                  '只会永久清理已在“最近删除”中达到期限的音频。默认关闭，不影响正常音频。',
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
          const GooText('AI 处理', variant: GooTextVariant.subtitle),
          const SizedBox(height: 8),
          GooList(
            style: GooListStyle.grouped,
            children: <Widget>[
              GooListItem(
                title: '处理位置',
                subtitle: switch (_audioProcessingLocation) {
                  AudioProcessingLocation.onDevice => '本机；不会上传音频内容',
                  AudioProcessingLocation.cloudDirect => '云端直连；每次生成前仍需确认',
                  AudioProcessingLocation.pairedPc => 'PC 配对；尚未开放',
                },
                showGuide: true,
                onTap: _chooseAudioProcessingLocation,
              ),
              if (_audioProcessingLocation ==
                  AudioProcessingLocation.cloudDirect)
                const GooListItem(
                  title: '云端提供商',
                  subtitle: 'DeepSeek（使用用户自己的账户）',
                ),
            ],
          ),
          if (_audioProcessingLocation ==
              AudioProcessingLocation.cloudDirect) ...<Widget>[
            const SizedBox(height: 8),
            GooInput(
              controller: _audioAiModelController,
              label: '模型 ID',
              placeholder: '输入 DeepSeek 模型 ID',
              showClearButton: true,
              autocorrect: false,
              enableSuggestions: false,
            ),
            const SizedBox(height: 8),
            GooInput(
              controller: _audioApiSecretController,
              label: 'API 密钥',
              helperText: _audioAiSecretConfigured
                  ? '已安全保存；留空将保持现有密钥'
                  : '由 Android Keystore 保护，不写入音频数据库',
              placeholder: _audioAiSecretConfigured
                  ? '输入新密钥以替换'
                  : '输入自己的 DeepSeek 密钥',
              obscureText: true,
              showVisibilityToggle: true,
              autocorrect: false,
              enableSuggestions: false,
            ),
            if (_audioAiSecretConfigured) ...<Widget>[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: GooButton(
                  variant: GooButtonVariant.secondary,
                  onPressed: _deleteAudioApiSecret,
                  child: const Text('删除云端密钥'),
                ),
              ),
            ],
          ],
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
                subtitle: '使用本地模型处理新转写，不会上传音频内容',
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
                    ? '已关闭；不会自动永久删除音频'
                    : '保留 $_recentlyDeletedRetentionDays 天；只清理最近删除',
                showGuide: true,
                semanticLabel:
                    '最近删除自动清理，'
                    '${_recentlyDeletedRetentionDays == null ? '已关闭' : '保留 $_recentlyDeletedRetentionDays 天'}',
                onTap: _chooseRetentionPolicy,
              ),
              GooListItem(
                title: '发送音频到 Mac',
                subtitle: '用户确认配对、加密分块续传；receipt 前绝不删除手机原件',
                leadingIconName: GooIcons.computer,
                showGuide: true,
                onTap: () => Navigator.of(context).pushNamed('/companion'),
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
