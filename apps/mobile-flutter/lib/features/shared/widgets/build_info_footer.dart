import 'package:flutter/material.dart';

import '../service/build_info_service.dart';

class BuildInfoFooter extends StatefulWidget {
  const BuildInfoFooter({super.key});

  @override
  State<BuildInfoFooter> createState() => _BuildInfoFooterState();
}

class _BuildInfoFooterState extends State<BuildInfoFooter> {
  static final BuildInfoService _service = BuildInfoService();
  late final Future<BuildInfo> _future;

  @override
  void initState() {
    super.initState();
    _future = _service.load();
  }

  @override
  Widget build(BuildContext context) {
    final textStyle = Theme.of(
      context,
    ).textTheme.bodySmall?.copyWith(color: Colors.grey.shade600, fontSize: 11);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.grey.withValues(alpha: 0.06),
        border: Border(
          top: BorderSide(color: Colors.grey.withValues(alpha: 0.2)),
        ),
      ),
      child: FutureBuilder<BuildInfo>(
        future: _future,
        builder: (BuildContext context, AsyncSnapshot<BuildInfo> snapshot) {
          if (!snapshot.hasData) {
            return Text('构建信息: 加载中...', style: textStyle);
          }
          final info = snapshot.data!;
          final updated = DateTime.fromMillisecondsSinceEpoch(
            info.lastUpdateTimeMs,
          );
          final updatedLabel =
              '${updated.year}-${updated.month.toString().padLeft(2, '0')}-${updated.day.toString().padLeft(2, '0')} '
              '${updated.hour.toString().padLeft(2, '0')}:${updated.minute.toString().padLeft(2, '0')}:${updated.second.toString().padLeft(2, '0')}';
          return Text(
            '包: ${info.packageName}  版本: ${info.versionName}  安装时间: $updatedLabel',
            style: textStyle,
          );
        },
      ),
    );
  }
}
