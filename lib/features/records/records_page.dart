import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:path/path.dart' as p;

import '../shared/utils/formatters.dart';
import '../shared/widgets/build_info_footer.dart';
import '../shared/widgets/common_empty_state.dart';
import 'model/recording_entity.dart';
import 'repository/recordings_repository.dart';
import 'widgets/recording_details_sheet.dart';

class RecordsPage extends StatefulWidget {
  const RecordsPage({super.key});

  @override
  State<RecordsPage> createState() => _RecordsPageState();
}

class _RecordsPageState extends State<RecordsPage> {
  final RecordingsRepository _repository = RecordingsRepository();

  List<RecordingEntity> _items = <RecordingEntity>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
    });
    final items = await _repository.listActive();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  Future<void> _showItemActions(RecordingEntity item) async {
    final String? action = await showGooPanel<String>(
      context: context,
      title: _displayTitle(item),
      builder:
          (
            BuildContext _,
            GooPanelController<String> controller,
            ScrollController _,
          ) {
            return GooList(
              children: <Widget>[
                GooListItem(
                  title: '查看详情',
                  leadingIconName: GooIcons.info,
                  onTap: () => controller.closeWithResult('detail'),
                ),
                GooListItem(
                  title: '删除记录',
                  leadingIconName: GooIcons.delete,
                  leadingIconTone: GooListIconTone.red,
                  titleTone: GooTextTone.error,
                  onTap: () => controller.closeWithResult('delete'),
                ),
              ],
            );
          },
    );

    if (!mounted || action == null) return;

    if (action == 'detail') {
      _showDetails(item);
      return;
    }

    if (action == 'delete') {
      await _deleteItem(item);
    }
  }

  void _showDetails(RecordingEntity item) {
    showRecordingDetailsSheet(
      context: context,
      title: _displayTitle(item),
      path: item.filePath,
      durationMs: item.durationMs,
      createdAtMs: item.createdAtMs,
      latestJob: null,
      recordingId: item.id,
    );
  }

  Future<void> _deleteItem(RecordingEntity item) async {
    final bool? confirmed = await showGooDialog<bool>(
      context: context,
      builder: (BuildContext _) {
        return const GooDialog<bool>.confirmation(
          title: '删除录音记录',
          description: '录音会移入最近删除，可在彻底删除前恢复。',
          actions: <GooDialogAction>[
            GooDialogAction(label: '取消', result: false),
            GooDialogAction(
              label: '删除',
              tone: GooDialogActionTone.destructive,
              style: GooDialogActionStyle.primary,
              result: true,
            ),
          ],
        );
      },
    );

    if (confirmed != true) return;

    await _repository.softDeleteById(item.id);

    if (!mounted) return;
    GooToastScope.of(context).success('已移入最近删除');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: GooAppBar.secondary(
        title: '记录',
        actions: <GooAppBarIconAction>[
          GooAppBarIconAction(
            iconName: GooIcons.refresh,
            onPressed: _load,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: GooSpinner(
                showLabel: true,
                label: '正在加载记录',
                liveRegion: true,
              ),
            )
          : _items.isEmpty
          ? const CommonEmptyState(
              icon: Icons.library_music_outlined,
              title: '暂无录音记录',
              description: '先回到录音页完成一次录音并保存，记录会出现在这里。',
            )
          : ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: _items.length,
              separatorBuilder: (BuildContext context, int index) =>
                  const SizedBox(height: 8),
              itemBuilder: (BuildContext context, int index) {
                final item = _items[index];
                return GestureDetector(
                  onLongPress: () => _showItemActions(item),
                  child: GooList(
                    style: GooListStyle.grouped,
                    children: <Widget>[
                      GooListItem(
                        title: _displayTitle(item),
                        subtitle:
                            '${formatDurationMs(item.durationMs)}  •  '
                            '${item.filePath}',
                        leadingIconName: GooIcons.mic,
                        showGuide: true,
                        onTap: () => _showDetails(item),
                      ),
                    ],
                  ),
                );
              },
            ),
      bottomNavigationBar: const SafeArea(top: false, child: BuildInfoFooter()),
    );
  }

  String _displayTitle(RecordingEntity item) {
    final String? displayName = item.displayName?.trim();
    if (displayName != null && displayName.isNotEmpty) {
      return displayName;
    }
    final String filename = p.basenameWithoutExtension(item.filePath).trim();
    if (filename.isNotEmpty) {
      return filename;
    }
    return '录音 #${item.id}';
  }
}
