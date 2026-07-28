import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../settings/model/transcription_model_descriptor.dart';
import '../shared/widgets/build_info_footer.dart';
import 'model/diagnostic_report.dart';
import 'service/diagnostic_report_service.dart';
import 'service/diagnostic_share_service.dart';

class HelpPage extends StatefulWidget {
  const HelpPage({super.key, this.reportService, this.shareService});

  final DiagnosticReportService? reportService;
  final DiagnosticShareService? shareService;

  @override
  State<HelpPage> createState() => _HelpPageState();
}

class _HelpPageState extends State<HelpPage> {
  static const int _contentVersion = 1;

  late final DiagnosticReportService _reportService;
  late final DiagnosticShareService _shareService;
  bool _diagnosticBusy = false;

  @override
  void initState() {
    super.initState();
    _reportService = widget.reportService ?? DiagnosticReportService();
    _shareService = widget.shareService ?? DiagnosticShareService();
  }

  List<_HelpTopic> get _topics => <_HelpTopic>[
    const _HelpTopic(
      title: '录音合规与权限',
      subtitle: '同意、麦克风权限和前台录音',
      icon: GooIcons.microphone,
      body:
          '开始录音前请确认已获得参与者同意，并遵守所在地法律和组织规则。'
          '应用只在你主动开始后使用麦克风；Android 会以持续通知显示前台录音状态。'
          '拒绝麦克风权限时不会创建录音。',
    ),
    const _HelpTopic(
      title: '录音与转写恢复',
      subtitle: '权限、空间、输入、转码、模型与保存错误',
      icon: GooIcons.help,
      body:
          '权限错误：在系统设置中重新允许麦克风。\n\n'
          '空间不足：清理空间后重试；应用会预留安全余量并停止继续写入。\n\n'
          '输入设备丢失：录音会回退到系统自动选择，并保留已写入内容。\n\n'
          '转码或模型错误：原始录音仍保留，可从记录页重试转写。\n\n'
          '持久化错误：不要卸载应用；重开后先检查待恢复录音，再重试。',
    ),
    _HelpTopic(
      title: '本地模型能力',
      subtitle: '当前可用能力与未开放边界',
      icon: GooIcons.modelNumber,
      body: _modelCapabilityDescription(),
    ),
    const _HelpTopic(
      title: '数据、删除与分享边界',
      subtitle: '私有存储、备份排除和临时只读分享',
      icon: GooIcons.privacy,
      body:
          '会议数据库、录音和派生文件保存在应用私有存储，并从 Android 云备份和设备迁移中排除。'
          '这表示“由设备安全设置保护”，不代表应用实现了独立内容加密。\n\n'
          '普通删除会先进入最近删除；永久删除会清理数据库图和受管文件。'
          '自动清理默认关闭，只处理达到所选期限的最近删除记录。\n\n'
          '导出和诊断通过系统分享以临时只读 URI 发送。应用不会创建公开链接或静默上传会议数据。',
    ),
  ];

  String _modelCapabilityDescription() {
    final descriptor = TranscriptionModelDescriptor.defaultModel();
    final ready = <String>[
      if (descriptor.offlineReady) '离线识别',
      if (descriptor.vadReady) 'VAD 切片',
      if (descriptor.punctuationReady) '离线标点',
    ];
    final gated = <String>[
      if (!descriptor.itn.verified) 'ITN 数字规范化',
      if (!descriptor.confidence.verified) '自动低置信度',
      if (!descriptor.hotwords.verified) '热词',
      if (!descriptor.enhancement.verified) '语音增强',
    ];
    return '${descriptor.name}：${descriptor.description}\n\n'
        '已开放：${ready.join('、')}。\n\n'
        '未开放：${gated.join('、')}。这些入口会保持隐藏，直到真实模型能力、许可和基准门禁同时通过。';
  }

  Future<void> _showTopic(_HelpTopic topic) {
    return showGooPanel<void>(
      context: context,
      title: topic.title,
      semanticLabel: '${topic.title}帮助内容',
      builder:
          (
            BuildContext context,
            GooPanelController<void> controller,
            ScrollController scrollController,
          ) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                GooText(topic.body, variant: GooTextVariant.body),
                const SizedBox(height: 20),
                GooButton(
                  onPressed: controller.close,
                  child: const Text('知道了'),
                ),
              ],
            );
          },
    );
  }

  Future<void> _previewDiagnostics() async {
    if (_diagnosticBusy) return;
    setState(() => _diagnosticBusy = true);
    try {
      final report = await _reportService.build();
      if (!mounted) return;
      final action = await _showDiagnosticPreview(report);
      if (!mounted || action != _DiagnosticPreviewAction.share) return;
      final artifact = await _shareService.build(report);
      await _shareService.share(artifact);
      if (!mounted) return;
      GooSnackbarScope.maybeOf(
        context,
      )?.show(message: '已打开系统分享；临时诊断包会在 24 小时内或下次启动时清理');
    } catch (_) {
      if (!mounted) return;
      GooToastScope.of(context).error('无法生成或分享安全诊断包');
    } finally {
      if (mounted) setState(() => _diagnosticBusy = false);
    }
  }

  Future<_DiagnosticPreviewAction?> _showDiagnosticPreview(
    DiagnosticReport report,
  ) {
    final timing = report.transcription;
    return showGooPanel<_DiagnosticPreviewAction>(
      context: context,
      title: '分享前预览',
      semanticLabel: '安全诊断包分享前预览',
      useRootNavigator: true,
      builder:
          (
            BuildContext context,
            GooPanelController<_DiagnosticPreviewAction> controller,
            ScrollController scrollController,
          ) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                const GooText('将包含', variant: GooTextVariant.subtitle),
                const SizedBox(height: 8),
                const GooText(
                  '构建版本、匿名任务状态与阶段计数、处理耗时、错误分类、设备保护类别。',
                  variant: GooTextVariant.body,
                ),
                const SizedBox(height: 16),
                const GooText('不会包含', variant: GooTextVariant.subtitle),
                const SizedBox(height: 8),
                const GooText(
                  '会议标题或正文、完整路径、内容 URI、原始日志、设备序列号、Android ID 或其他稳定设备标识。',
                  variant: GooTextVariant.body,
                ),
                const SizedBox(height: 16),
                GooList(
                  style: GooListStyle.grouped,
                  children: <Widget>[
                    GooListItem(
                      title: '构建版本',
                      subtitle: report.build.versionName,
                    ),
                    GooListItem(
                      title: '设备保护',
                      subtitle: report.deviceProtection.protectionSummary,
                    ),
                    GooListItem(
                      title: '匿名转写统计',
                      subtitle:
                          '${report.transcription.statusCounts.values.fold<int>(0, (sum, count) => sum + count)} 个任务 · '
                          '${timing.timedJobCount} 个耗时样本',
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                const GooText(
                  '诊断包只在你确认后生成，通过系统分享发送，不会静默联网。'
                  '包位于专用临时缓存，保留上限为 24 小时；直接关闭系统选择器时由超时或下次启动清理。',
                  variant: GooTextVariant.caption,
                ),
                const SizedBox(height: 20),
                GooButton(
                  onPressed: () => controller.closeWithResult(
                    _DiagnosticPreviewAction.share,
                  ),
                  child: const Text('生成并打开系统分享'),
                ),
                const SizedBox(height: 8),
                GooButton.text(
                  onPressed: controller.close,
                  child: const Text('取消'),
                ),
              ],
            );
          },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const GooAppBar.secondary(title: '帮助与反馈'),
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          return Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: <Widget>[
                  GooTag(
                    label: '离线帮助 v$_contentVersion',
                    accent: GooTagAccent.green,
                  ),
                  const SizedBox(height: 12),
                  const GooText(
                    '帮助内容随应用提供，无需网络。',
                    variant: GooTextVariant.body,
                  ),
                  const SizedBox(height: 16),
                  GooList(
                    style: GooListStyle.grouped,
                    children: _topics
                        .map(
                          (topic) => GooListItem(
                            title: topic.title,
                            subtitle: topic.subtitle,
                            leadingIconName: topic.icon,
                            showGuide: true,
                            onTap: () => _showTopic(topic),
                          ),
                        )
                        .toList(growable: false),
                  ),
                  const SizedBox(height: 20),
                  const GooText('反馈与安全诊断', variant: GooTextVariant.subtitle),
                  const SizedBox(height: 8),
                  const GooText(
                    '当前没有获批的后台反馈上传接口。你可以先查看字段清单，再主动通过系统分享发送安全诊断包。',
                    variant: GooTextVariant.body,
                  ),
                  const SizedBox(height: 12),
                  GooButton(
                    onPressed: _diagnosticBusy ? null : _previewDiagnostics,
                    child: Text(_diagnosticBusy ? '正在准备…' : '预览安全诊断'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
      bottomNavigationBar: const SafeArea(top: false, child: BuildInfoFooter()),
    );
  }
}

class _HelpTopic {
  const _HelpTopic({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.body,
  });

  final String title;
  final String subtitle;
  final GooIconId icon;
  final String body;
}

enum _DiagnosticPreviewAction { share }
