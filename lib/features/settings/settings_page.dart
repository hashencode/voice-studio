import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';

import '../../app/theme/theme_mode_controller.dart';
import 'model/app_settings.dart';
import 'model/transcription_model_descriptor.dart';
import 'repository/app_settings_repository.dart';
import '../shared/widgets/build_info_footer.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final AppSettingsRepository _repository = AppSettingsRepository();

  bool _loading = true;
  String _modelId = 'paraformer-zh';
  RecordingMode _recordingMode = RecordingMode.standard;
  bool _autoTranscribe = true;
  bool _isDarkMode = false;

  @override
  void initState() {
    super.initState();
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
      _recordingMode = settings.recordingMode;
      _autoTranscribe = settings.autoTranscribe;
      _isDarkMode = settings.isDarkMode;
      _loading = false;
    });
  }

  Future<void> _save() async {
    final messenger = ScaffoldMessenger.of(context);
    final AppThemeModeController themeController = AppThemeModeScope.of(
      context,
    );
    await _repository.save(
      AppSettings(
        modelId: _modelId,
        recordingMode: _recordingMode,
        autoTranscribe: _autoTranscribe,
        isDarkMode: _isDarkMode,
      ),
    );
    await themeController.setDarkMode(_isDarkMode);
    if (!mounted) return;
    messenger.showSnackBar(const SnackBar(content: Text('设置已保存')));
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Scaffold(
        appBar: const GooAppBar.secondary(title: '设置'),
        body: const Center(child: CircularProgressIndicator()),
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
          const GooText('录音模式', variant: GooTextVariant.subtitle),
          const SizedBox(height: 8),
          GooSegmentedButton<RecordingMode>(
            value: _recordingMode,
            onValueChange: (RecordingMode value) {
              setState(() {
                _recordingMode = value;
              });
            },
            items: RecordingMode.values
                .map(
                  (RecordingMode mode) => GooSegmentedButtonItem<RecordingMode>(
                    value: mode,
                    label: mode.label,
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 8),
          GooText(_recordingMode.description, variant: GooTextVariant.caption),
          const SizedBox(height: 16),
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
      if (descriptor.canTranscribeRealtime) '分段实时可用',
      if (!descriptor.punctuationReady) '标点未开放',
      if (!descriptor.denoiseReady) '降噪未开放',
    ].join(' · ');

    return GooListItem(
      title: descriptor.name,
      subtitle: '${descriptor.description}\n$capabilities',
      disabled: !descriptor.selectable,
      selected: selected,
      trailing: selected
          ? Icon(
              Icons.check_circle,
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
