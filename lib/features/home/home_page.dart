import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:path/path.dart' as p;

import '../../app/theme/theme_mode_controller.dart';
import 'model/folder_entity.dart';
import 'repository/folders_repository.dart';
import '../records/model/recording_entity.dart';
import '../records/repository/recordings_repository.dart';
import '../records/widgets/recording_details_sheet.dart';
import '../shared/utils/formatters.dart';
import '../transcription/repository/transcription_jobs_repository.dart';
import '../transcription/repository/transcript_segments_repository.dart';
import 'home_tokens.dart';

const String _allTab = 'all';
const String _meetingTab = 'meeting';
const String _recentlyDeletedTab = 'recentlyDeleted';

enum _HomeViewMode { loading, empty, normal, selection }

class HomePage extends StatefulWidget {
  const HomePage({
    super.key,
    this.recordingsRepository,
    this.foldersRepository,
    this.transcriptionJobsRepository,
    this.transcriptSegmentsRepository,
  });

  final RecordingsRepository? recordingsRepository;
  final FoldersRepository? foldersRepository;
  final TranscriptionJobsRepository? transcriptionJobsRepository;
  final TranscriptSegmentsRepository? transcriptSegmentsRepository;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  late final RecordingsRepository _repository;
  late final FoldersRepository _foldersRepository;
  late final TranscriptionJobsRepository _transcriptionJobsRepository;
  late final TranscriptSegmentsRepository _transcriptSegmentsRepository;
  static final List<_RecordingPreview> _visualPlaceholderItems =
      <_RecordingPreview>[
        _RecordingPreview(
          id: -1,
          filePath: '',
          title: '导入音频-2605071125',
          durationMs: 0,
          createdAtMs: DateTime(2026, 5, 7, 11, 25).millisecondsSinceEpoch,
          duration: '未知时长',
          date: '2026-05-07 11:25',
          favorite: true,
        ),
        _RecordingPreview(
          id: -2,
          filePath: '',
          title: '产品讨论会-2605071410',
          durationMs: 88000,
          createdAtMs: DateTime(2026, 5, 7, 14, 10).millisecondsSinceEpoch,
          duration: '01:28',
          date: '2026-05-07 14:10',
        ),
        _RecordingPreview(
          id: -3,
          filePath: '',
          title: '周会纪要-2605080932',
          durationMs: 766000,
          createdAtMs: DateTime(2026, 5, 8, 9, 32).millisecondsSinceEpoch,
          duration: '12:46',
          date: '2026-05-08 09:32',
        ),
        _RecordingPreview(
          id: -4,
          filePath: '',
          title: '采访录音-2605081548',
          durationMs: 1395000,
          createdAtMs: DateTime(2026, 5, 8, 15, 48).millisecondsSinceEpoch,
          duration: '23:15',
          date: '2026-05-08 15:48',
        ),
        _RecordingPreview(
          id: -5,
          filePath: '',
          title: '灵感速记-2605090806',
          durationMs: 42000,
          createdAtMs: DateTime(2026, 5, 9, 8, 6).millisecondsSinceEpoch,
          duration: '00:42',
          date: '2026-05-09 08:06',
        ),
        _RecordingPreview(
          id: -6,
          filePath: '',
          title: '客户访谈-2605091630',
          durationMs: 2048000,
          createdAtMs: DateTime(2026, 5, 9, 16, 30).millisecondsSinceEpoch,
          duration: '34:08',
          date: '2026-05-09 16:30',
          favorite: true,
        ),
        _RecordingPreview(
          id: -7,
          filePath: '',
          title: '课程整理-2605101015',
          durationMs: 534000,
          createdAtMs: DateTime(2026, 5, 10, 10, 15).millisecondsSinceEpoch,
          duration: '08:54',
          date: '2026-05-10 10:15',
        ),
        _RecordingPreview(
          id: -8,
          filePath: '',
          title: '晨会同步-2605101118',
          durationMs: 201000,
          createdAtMs: DateTime(2026, 5, 10, 11, 18).millisecondsSinceEpoch,
          duration: '03:21',
          date: '2026-05-10 11:18',
        ),
        _RecordingPreview(
          id: -9,
          filePath: '',
          title: '需求评审-2605111342',
          durationMs: 1059000,
          createdAtMs: DateTime(2026, 5, 11, 13, 42).millisecondsSinceEpoch,
          duration: '17:39',
          date: '2026-05-11 13:42',
        ),
        _RecordingPreview(
          id: -10,
          filePath: '',
          title: '导入音频-2605111816',
          durationMs: 0,
          createdAtMs: DateTime(2026, 5, 11, 18, 16).millisecondsSinceEpoch,
          duration: '未知时长',
          date: '2026-05-11 18:16',
        ),
      ];

  List<_RecordingPreview> _items = const <_RecordingPreview>[];
  List<FolderEntity> _folders = const <FolderEntity>[];
  late final GooSelectionController<int> _selectionController;
  late final List<_RecordingPreview> _placeholderItems;
  bool _loading = true;
  String? _loadError;
  String _activeTab = _allTab;

  List<_HomeTabSpec> get _tabs => <_HomeTabSpec>[
    const _HomeTabSpec(id: _allTab, label: '全部音频'),
    const _HomeTabSpec(id: _meetingTab, label: '会议音频'),
    ..._folders.map(
      (FolderEntity folder) =>
          _HomeTabSpec(id: folder.name, label: folder.name),
    ),
    const _HomeTabSpec(id: _recentlyDeletedTab, label: '最近删除'),
  ];

  bool get _isCustomGroupTab =>
      _activeTab != _allTab &&
      _activeTab != _meetingTab &&
      _activeTab != _recentlyDeletedTab;

  bool get _usesAllTabPlaceholder =>
      _activeTab == _allTab &&
      _items.isEmpty &&
      _loadError == null &&
      _placeholderItems.isNotEmpty;

  List<_RecordingPreview> get _visibleItems {
    switch (_activeTab) {
      case _recentlyDeletedTab:
      case _meetingTab:
        return _items;
      case _allTab:
      default:
        return _isCustomGroupTab
            ? _items
            : (_usesAllTabPlaceholder ? _placeholderItems : _items);
    }
  }

  Set<int> get _selectedIds => _selectionController.selectedValues;

  List<int> get _visibleItemIds => _visibleItems
      .map((_RecordingPreview item) => item.id)
      .toList(growable: false);

  bool get _isSelectionMode => _selectionController.hasSelection;

  bool get _allVisibleSelected {
    final List<int> ids = _visibleItemIds;
    return ids.isNotEmpty && ids.every(_selectedIds.contains);
  }

  bool get _hasPlaceholderSelection => _visibleItems
      .where((item) => _selectedIds.contains(item.id))
      .any((item) => item.id <= 0);
  bool get _canToggleSelectAll => _visibleItems.isNotEmpty;
  String get _selectionTrailingLabel => _allVisibleSelected ? '取消全选' : '全选';
  bool get _canRenameSelection =>
      _activeTab != _recentlyDeletedTab &&
      _selectedIds.length == 1 &&
      !_hasPlaceholderSelection;
  bool get _canDeleteSelection =>
      _selectedIds.isNotEmpty && !_hasPlaceholderSelection;

  _HomeViewMode get _viewMode {
    if (_loading) {
      return _HomeViewMode.loading;
    }
    if (_isSelectionMode) {
      return _HomeViewMode.selection;
    }
    if (_visibleItems.isEmpty) {
      return _HomeViewMode.empty;
    }
    return _HomeViewMode.normal;
  }

  @override
  void initState() {
    super.initState();
    _repository = widget.recordingsRepository ?? RecordingsRepository();
    _foldersRepository = widget.foldersRepository ?? FoldersRepository();
    _transcriptionJobsRepository =
        widget.transcriptionJobsRepository ?? TranscriptionJobsRepository();
    _transcriptSegmentsRepository =
        widget.transcriptSegmentsRepository ?? TranscriptSegmentsRepository();
    _selectionController = GooSelectionController<int>(
      enableHapticFeedback: true,
    )..addListener(_handleSelectionChanged);
    _placeholderItems = List<_RecordingPreview>.of(_visualPlaceholderItems);
    _load();
  }

  @override
  void dispose() {
    _selectionController
      ..removeListener(_handleSelectionChanged)
      ..dispose();
    super.dispose();
  }

  void _handleSelectionChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  void _reconcileSelectionWithVisibleItems({required bool haptic}) {
    final Set<int> visibleIds = _visibleItemIds.toSet();
    final List<int> nextSelection = _selectedIds
        .where(visibleIds.contains)
        .toList(growable: false);
    if (nextSelection.length == _selectedIds.length) {
      return;
    }
    _selectionController.replaceSelection(nextSelection, haptic: haptic);
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _loadError = null;
      });
    }

    try {
      final List<Object> results = await Future.wait<Object>(<Future<Object>>[
        _foldersRepository.listFolders(),
        switch (_activeTab) {
          _recentlyDeletedTab => _repository.listDeleted(),
          _ => _repository.listActive(
            groupName: _activeTab == _allTab ? null : _activeTab,
          ),
        },
      ]);
      final List<FolderEntity> folders = results[0] as List<FolderEntity>;
      final List<RecordingEntity> records = results[1] as List<RecordingEntity>;
      if (!mounted) return;
      setState(() {
        _folders = folders;
        _items = records.map(_RecordingPreview.fromEntity).toList();
        _loading = false;
      });
      _reconcileSelectionWithVisibleItems(haptic: false);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _folders = const <FolderEntity>[];
        _items = const <_RecordingPreview>[];
        _loading = false;
        _loadError = '列表加载失败，请稍后重试';
      });
      _selectionController.clearSelection(haptic: false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('列表加载失败，请稍后重试')));
    }
  }

  void _selectTab(String tabId) {
    if (_activeTab == tabId) return;
    setState(() {
      _activeTab = tabId;
      _loading = true;
      _loadError = null;
    });
    _selectionController.clearSelection(haptic: false);
    _load();
  }

  void _enterSelection(_RecordingPreview item) {
    _selectionController.replaceSelection(<int>[item.id]);
  }

  void _toggleSelection(_RecordingPreview item) {
    _selectionController.toggle(item.id);
  }

  void _clearSelection() {
    _selectionController.clearSelection();
  }

  void _toggleSelectAll() {
    if (!_canToggleSelectAll) return;
    if (_allVisibleSelected) {
      _selectionController.clearSelection();
      return;
    }
    _selectionController.selectAll(_visibleItemIds);
  }

  _RecordingPreview? get _singleSelectedItem {
    if (_selectedIds.length != 1) return null;
    final int selectedId = _selectedIds.first;
    for (final _RecordingPreview item in _visibleItems) {
      if (item.id == selectedId) return item;
    }
    return null;
  }

  Future<void> _openRenameDialogForSelection() async {
    final _RecordingPreview? item = _singleSelectedItem;
    if (item == null || item.id <= 0) {
      return;
    }
    await _openRenameDialog(item);
  }

  Future<void> _openRenameDialog(_RecordingPreview item) async {
    final TextEditingController controller = TextEditingController(
      text: item.title,
    );
    String? errorText;

    final String? nextName = await showDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            return AlertDialog(
              title: const Text('重命名文件'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text('只修改显示名称，不会修改原始文件名。'),
                  const SizedBox(height: 12),
                  TextField(
                    controller: controller,
                    autofocus: true,
                    decoration: InputDecoration(
                      hintText: '输入新的文件名',
                      errorText: errorText,
                    ),
                    onChanged: (_) {
                      if (errorText != null) {
                        setModalState(() {
                          errorText = null;
                        });
                      }
                    },
                    onSubmitted: (_) {
                      final String? validationError = _validateDisplayName(
                        controller.text,
                        item.id,
                      );
                      if (validationError != null) {
                        setModalState(() {
                          errorText = validationError;
                        });
                        return;
                      }
                      Navigator.of(context).pop(controller.text.trim());
                    },
                  ),
                ],
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('取消'),
                ),
                FilledButton(
                  onPressed: () {
                    final String? validationError = _validateDisplayName(
                      controller.text,
                      item.id,
                    );
                    if (validationError != null) {
                      setModalState(() {
                        errorText = validationError;
                      });
                      return;
                    }
                    Navigator.of(context).pop(controller.text.trim());
                  },
                  child: const Text('保存'),
                ),
              ],
            );
          },
        );
      },
    );
    controller.dispose();

    if (!mounted || nextName == null) return;
    await _renameItem(item, nextName);
  }

  String? _validateDisplayName(String input, int itemId) {
    final String value = input.trim();
    if (value.isEmpty) {
      return '名称不能为空';
    }
    if (value.length > 255) {
      return '名称过长，请控制在 255 个字符以内';
    }
    if (RegExp(r'[/\\:*?"<>|\u0000-\u001F]').hasMatch(value)) {
      return '名称包含非法字符（\\ / : * ? " < > |）';
    }
    if (RegExp(r'[.\s]$').hasMatch(value)) {
      return '名称不能以空格或英文句点结尾';
    }
    if (value == '.' || value == '..') {
      return '名称不合法';
    }
    final String normalized = value.toLowerCase();
    final List<_RecordingPreview> source = _usesAllTabPlaceholder
        ? _placeholderItems
        : _items;
    for (final _RecordingPreview entry in source) {
      if (entry.id == itemId) continue;
      if (entry.title.trim().toLowerCase() == normalized) {
        return '名称已存在，请使用其他名称';
      }
    }
    return null;
  }

  Future<void> _renameItem(_RecordingPreview item, String displayName) async {
    if (item.id <= 0) {
      if (!mounted) return;
      setState(() {
        final int index = _placeholderItems.indexWhere(
          (_RecordingPreview current) => current.id == item.id,
        );
        if (index != -1) {
          _placeholderItems[index] = _placeholderItems[index].copyWith(
            title: displayName,
          );
        }
      });
      _selectionController.clearSelection(haptic: false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('样式占位已重命名')));
      return;
    }

    await _repository.updateDisplayName(id: item.id, displayName: displayName);
    if (!mounted) return;
    setState(() {
      _items = _items.map((_RecordingPreview current) {
        if (current.id != item.id) {
          return current;
        }
        return current.copyWith(title: displayName);
      }).toList();
    });
    _selectionController.clearSelection(haptic: false);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('重命名成功')));
  }

  bool _isReservedGroupName(String name) {
    final String normalized = name.trim().toLowerCase();
    return normalized == _allTab ||
        normalized == _meetingTab ||
        normalized == _recentlyDeletedTab.toLowerCase();
  }

  String? _validateGroupName(String input) {
    final String value = input.trim();
    if (value.isEmpty) {
      return '名称不能为空';
    }
    if (value.length > 64) {
      return '名称过长，请控制在 64 个字符以内';
    }
    if (RegExp(r'[/\\:*?"<>|\u0000-\u001F]').hasMatch(value)) {
      return '名称包含非法字符（\\ / : * ? " < > |）';
    }
    if (_isReservedGroupName(value)) {
      return '该名称为系统保留分组';
    }
    if (_folders.any(
      (FolderEntity folder) => folder.name.toLowerCase() == value.toLowerCase(),
    )) {
      return '分组名称已存在';
    }
    return null;
  }

  Future<String?> _openCreateGroupDialog() async {
    final TextEditingController controller = TextEditingController();
    String? errorText;

    final String? nextName = await showDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            return AlertDialog(
              title: const Text('新建分组'),
              content: TextField(
                controller: controller,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: '输入分组名称',
                  errorText: errorText,
                ),
                onChanged: (_) {
                  if (errorText != null) {
                    setModalState(() {
                      errorText = null;
                    });
                  }
                },
                onSubmitted: (_) {
                  final String? validationError = _validateGroupName(
                    controller.text,
                  );
                  if (validationError != null) {
                    setModalState(() {
                      errorText = validationError;
                    });
                    return;
                  }
                  Navigator.of(context).pop(controller.text.trim());
                },
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('取消'),
                ),
                FilledButton(
                  onPressed: () {
                    final String? validationError = _validateGroupName(
                      controller.text,
                    );
                    if (validationError != null) {
                      setModalState(() {
                        errorText = validationError;
                      });
                      return;
                    }
                    Navigator.of(context).pop(controller.text.trim());
                  },
                  child: const Text('创建'),
                ),
              ],
            );
          },
        );
      },
    );
    controller.dispose();
    return nextName;
  }

  Future<String?> _createFolder() async {
    final String? folderName = await _openCreateGroupDialog();
    if (!mounted || folderName == null) return null;
    await _foldersRepository.createFolder(folderName);
    if (!mounted) return null;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('分组创建成功')));
    await _load();
    return folderName;
  }

  Future<void> _moveItemToGroup(
    _RecordingPreview item, {
    required String targetGroup,
  }) async {
    if (item.id <= 0) {
      setState(() {
        final int index = _placeholderItems.indexWhere(
          (_RecordingPreview current) => current.id == item.id,
        );
        if (index != -1) {
          _placeholderItems[index] = _placeholderItems[index].copyWith(
            groupName: targetGroup,
          );
        }
      });
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('样式占位已移动到$targetGroup')));
      return;
    }

    await _repository.updateGroupName(id: item.id, groupName: targetGroup);
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('已移动到$targetGroup')));
    await _load();
  }

  Future<void> _openMoveSheet(_RecordingPreview item) async {
    final String? targetGroup = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (BuildContext context) {
        return _MoveGroupSheet(
          title: item.title,
          folders: _folders.map((FolderEntity folder) => folder.name).toList(),
        );
      },
    );

    if (!mounted || targetGroup == null) return;

    if (targetGroup == '__create__') {
      final String? createdGroup = await _createFolder();
      if (!mounted || createdGroup == null) return;
      await _moveItemToGroup(item, targetGroup: createdGroup);
      return;
    }

    await _moveItemToGroup(item, targetGroup: targetGroup);
  }

  Future<void> _showItemActions(_RecordingPreview item) async {
    if (_activeTab == _recentlyDeletedTab) {
      final Color destructiveColor = HomePagePalette.of(context).favorite;
      final GooShareTarget? target = await showGooSharePanel(
        context: context,
        title: item.title,
        leadingActionLabel: '取消',
        previewText: '${item.duration} · ${item.date}',
        channels: const <GooShareTarget>[],
        targets: <GooShareTarget>[
          const GooShareTarget(
            id: 'restore',
            label: '恢复',
            iconName: 'rotate-ccw',
          ),
          GooShareTarget(
            id: 'delete',
            label: '彻底删除',
            iconName: 'trash-2',
            iconColor: destructiveColor,
          ),
        ],
      );

      if (!mounted || target == null) return;
      switch (target.resolvedId) {
        case 'restore':
          await _restoreItems(<_RecordingPreview>[item]);
          return;
        case 'delete':
          await _deleteItems(<_RecordingPreview>[item]);
          return;
        default:
          return;
      }
    }

    final String favoriteLabel = item.favorite ? '取消收藏' : '收藏';
    final String favoriteIconName = item.favorite ? 'heart-off' : 'heart';
    final Color destructiveColor = HomePagePalette.of(context).favorite;
    final GooShareTarget? target = await showGooSharePanel(
      context: context,
      title: item.title,
      leadingActionLabel: '取消',
      previewText: '${item.duration} · ${item.date}',
      channels: const <GooShareTarget>[],
      targets: <GooShareTarget>[
        const GooShareTarget(
          id: 'rename',
          label: '重命名',
          iconName: 'pencil-line',
        ),
        const GooShareTarget(
          id: 'move',
          label: '移动到',
          iconName: 'folder-input',
        ),
        GooShareTarget(
          id: 'favorite',
          label: favoriteLabel,
          iconName: favoriteIconName,
        ),
        const GooShareTarget(id: 'share', label: '分享', iconName: 'share-2'),
        GooShareTarget(
          id: 'delete',
          label: '删除',
          iconName: 'trash-2',
          iconColor: destructiveColor,
        ),
      ],
    );

    if (!mounted || target == null) return;

    switch (target.resolvedId) {
      case 'rename':
        await _openRenameDialog(item);
        return;
      case 'delete':
        await _deleteItems(<_RecordingPreview>[item]);
        return;
      case 'favorite':
        await _toggleFavorite(item);
        return;
      case 'share':
        await _shareItem(item);
        return;
      case 'move':
        await _openMoveSheet(item);
        return;
      default:
        return;
    }
  }

  Future<void> _toggleFavorite(_RecordingPreview item) async {
    if (item.id <= 0) {
      setState(() {
        final int index = _placeholderItems.indexWhere(
          (_RecordingPreview current) => current.id == item.id,
        );
        if (index != -1) {
          final _RecordingPreview current = _placeholderItems[index];
          _placeholderItems[index] = current.copyWith(
            favorite: !current.favorite,
          );
        }
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(item.favorite ? '已取消收藏样式占位' : '已收藏样式占位')),
      );
      return;
    }

    final bool nextFavorite = !item.favorite;
    await _repository.updateFavorite(id: item.id, isFavorite: nextFavorite);
    if (!mounted) return;
    setState(() {
      _items = _items.map((_RecordingPreview current) {
        if (current.id != item.id) {
          return current;
        }
        return current.copyWith(favorite: nextFavorite);
      }).toList();
    });
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(nextFavorite ? '已收藏文件' : '已取消收藏文件')));
  }

  Future<void> _openItem(_RecordingPreview item) async {
    final latestJob = item.id <= 0
        ? null
        : await _transcriptionJobsRepository.findLatestByRecordingPath(
            item.filePath,
          );
    if (!mounted) return;
    await showRecordingDetailsSheet(
      context: context,
      title: item.title,
      path: item.filePath.isEmpty ? '样式占位数据' : item.filePath,
      durationMs: item.durationMs,
      createdAtMs: item.createdAtMs,
      latestJob: latestJob,
    );
  }

  Future<void> _shareItem(_RecordingPreview item) async {
    final String shareText = item.filePath.isNotEmpty
        ? item.filePath
        : '${item.title}\n${item.date} · ${item.duration}';
    await Clipboard.setData(ClipboardData(text: shareText));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('已复制分享内容')));
  }

  Future<void> _deleteSelected() async {
    final List<_RecordingPreview> selectedItems = _visibleItems
        .where((item) => _selectedIds.contains(item.id))
        .toList();
    if (selectedItems.isEmpty) {
      return;
    }
    await _deleteItems(selectedItems);
  }

  Future<void> _deleteItems(List<_RecordingPreview> items) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) {
        final bool isRecentlyDeleted = _activeTab == _recentlyDeletedTab;
        final bool hasPlaceholder = items.any((item) => item.id <= 0);
        return AlertDialog(
          title: Text(
            hasPlaceholder
                ? (items.length == 1 ? '移除样式占位' : '批量移除样式占位')
                : isRecentlyDeleted
                ? (items.length == 1 ? '确认彻底删除' : '批量彻底删除')
                : (items.length == 1 ? '确认删除' : '批量删除'),
          ),
          content: Text(
            hasPlaceholder
                ? (items.length == 1
                      ? '会从当前首页样式预览中移除该占位项。'
                      : '会从当前首页样式预览中移除 ${items.length} 个占位项。')
                : isRecentlyDeleted
                ? (items.length == 1
                      ? '删除后无法恢复，会同时清理关联转写数据。'
                      : '删除后无法恢复，会同时清理 ${items.length} 条录音的关联转写数据。')
                : (items.length == 1
                      ? '会将该录音移入最近删除。'
                      : '会将 ${items.length} 条录音移入最近删除。'),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(
                hasPlaceholder ? '移除' : (isRecentlyDeleted ? '彻底删除' : '确认删除'),
              ),
            ),
          ],
        );
      },
    );

    if (confirmed != true) return;

    if (items.any((item) => item.id <= 0)) {
      final Set<int> placeholderIds = items.map((item) => item.id).toSet();
      setState(() {
        _placeholderItems.removeWhere(
          (_RecordingPreview item) => placeholderIds.contains(item.id),
        );
      });
      _selectionController.replaceSelection(
        _selectedIds
            .where((int id) => !placeholderIds.contains(id))
            .toList(growable: false),
        haptic: false,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            items.length == 1 ? '已移除样式占位' : '已移除 ${items.length} 个样式占位',
          ),
        ),
      );
      return;
    }

    for (final _RecordingPreview item in items) {
      if (_activeTab == _recentlyDeletedTab) {
        await _repository.deleteById(item.id);
        await _transcriptionJobsRepository.deleteByRecordingPath(item.filePath);
        await _transcriptSegmentsRepository.deleteByRecordingPath(
          item.filePath,
        );
      } else {
        await _repository.softDeleteById(item.id);
      }
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          _activeTab == _recentlyDeletedTab
              ? (items.length == 1
                    ? '已彻底删除记录并清理关联数据'
                    : '已彻底删除 ${items.length} 条记录并清理关联数据')
              : (items.length == 1
                    ? '已移入最近删除'
                    : '已将 ${items.length} 条记录移入最近删除'),
        ),
      ),
    );
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  Future<void> _restoreItems(List<_RecordingPreview> items) async {
    for (final _RecordingPreview item in items) {
      if (item.id <= 0) {
        continue;
      }
      await _repository.restoreById(item.id);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(items.length == 1 ? '已恢复' : '已恢复 ${items.length} 条记录'),
      ),
    );
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  void _showComingSoon(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  String _emptyText() {
    if (_loadError != null) return _loadError!;
    switch (_activeTab) {
      case _recentlyDeletedTab:
        return '最近删除为空';
      case _meetingTab:
      case _allTab:
      default:
        return '暂无录音文件';
    }
  }

  PreferredSizeWidget _buildAppBar(
    HomePagePalette palette,
    AppThemeModeController? themeController,
  ) {
    if (_viewMode == _HomeViewMode.selection) {
      return GooAppBar.secondaryEditing(
        title: '音频',
        subtitle: '已选择 ${_selectedIds.length} 项',
        leadingActionLabel: '取消',
        trailingActionLabel: _selectionTrailingLabel,
        onLeadingAction: _clearSelection,
        onTrailingAction: _canToggleSelectAll ? _toggleSelectAll : null,
        backgroundColor: palette.background,
      );
    }

    return GooAppBar.secondary(
      title: '音频',
      backgroundColor: palette.background,
      actions: <GooAppBarIconAction>[
        GooAppBarIconAction(
          iconName: 'search',
          semanticLabel: '搜索',
          tooltip: '搜索',
          onPressed: () => _showComingSoon('搜索功能即将上线'),
        ),
        GooAppBarIconAction(
          iconName: 'file-input',
          semanticLabel: '导入',
          tooltip: '导入',
          onPressed: () {},
        ),
        GooAppBarIconAction(
          iconName: themeController?.isDarkMode == true ? 'moon' : 'sun',
          semanticLabel: '主题',
          tooltip: '主题',
          onPressed: () => themeController?.toggle(),
        ),
      ],
    );
  }

  List<GooToolBarItem> _selectionToolbarItems(
    BuildContext context,
    GooSelectionState<int> state,
  ) {
    if (!state.hasSelection) {
      return const <GooToolBarItem>[];
    }

    return <GooToolBarItem>[
      GooToolBarItem(
        iconName: 'pencil-line',
        label: '重命名',
        semanticLabel: '重命名所选音频',
        onPressed: _canRenameSelection
            ? () {
                _openRenameDialogForSelection();
              }
            : null,
      ),
      GooToolBarItem(
        iconName: 'trash-2',
        label: '删除',
        semanticLabel: '删除所选音频',
        onPressed: _canDeleteSelection
            ? () {
                _deleteSelected();
              }
            : null,
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final HomePagePalette palette = HomePagePalette.of(context);
    final AppThemeModeController? themeController = AppThemeModeScope.maybeOf(
      context,
    );
    final double bottomInset = MediaQuery.of(context).padding.bottom;
    final double fabBottom = bottomInset + HomePageMetrics.fabBottomSpacing;
    final double selectionToolbarInset =
        HomePageMetrics.selectionToolbarDockHeight +
        HomePageMetrics.selectionToolbarDockGap +
        bottomInset;

    return Scaffold(
      appBar: _buildAppBar(palette, themeController),
      body: GooSelectionOverlay<int>(
        controller: _selectionController,
        toolbarSemanticLabel: '音频选择操作',
        toolbarBuilder: _selectionToolbarItems,
        body: ColoredBox(
          color: palette.background,
          child: Stack(
            children: <Widget>[
              Column(
                children: <Widget>[
                  _HomeTabs(
                    tabs: _tabs,
                    activeTab: _activeTab,
                    onTabPressed: _selectTab,
                    onCreateFolder: _createFolder,
                  ),
                  Expanded(
                    child: _HomeContent(
                      mode: _viewMode,
                      palette: palette,
                      items: _visibleItems,
                      selectedIds: _selectedIds,
                      emptyText: _emptyText(),
                      selectionBottomInset: selectionToolbarInset,
                      onOpenItem: _openItem,
                      onLongPressItem: _enterSelection,
                      onToggleSelection: _toggleSelection,
                      onMorePressed: _showItemActions,
                    ),
                  ),
                ],
              ),
              if (!_isSelectionMode)
                Positioned(
                  left: HomePageMetrics.horizontalPadding,
                  bottom: fabBottom,
                  child: _RecordFab(
                    palette: palette,
                    onPressed: () {
                      Navigator.of(context).pushNamed('/recording');
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: null,
    );
  }
}

class _HomeTabs extends StatelessWidget {
  const _HomeTabs({
    required this.tabs,
    required this.activeTab,
    required this.onTabPressed,
    required this.onCreateFolder,
  });

  final List<_HomeTabSpec> tabs;
  final String activeTab;
  final ValueChanged<String> onTabPressed;
  final VoidCallback onCreateFolder;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: HomePageMetrics.tabsPaddingVertical),
      child: GooTabs(
        value: activeTab,
        onValueChange: onTabPressed,
        layout: GooTabsLayout.overlength,
        showContent: false,
        actions: <GooTabAction>[
          GooTabAction(
            iconName: 'folder-plus',
            semanticLabel: '新建分组',
            onPressed: onCreateFolder,
          ),
        ],
        tabs: tabs
            .map(
              (_HomeTabSpec tab) => GooTabItem(
                value: tab.id,
                label: GooText.inherit(tab.label),
                child: const SizedBox.shrink(),
              ),
            )
            .toList(growable: false),
      ),
    );
  }
}

class _HomeContent extends StatelessWidget {
  const _HomeContent({
    required this.mode,
    required this.palette,
    required this.items,
    required this.selectedIds,
    required this.emptyText,
    required this.selectionBottomInset,
    required this.onOpenItem,
    required this.onLongPressItem,
    required this.onToggleSelection,
    required this.onMorePressed,
  });

  final _HomeViewMode mode;
  final HomePagePalette palette;
  final List<_RecordingPreview> items;
  final Set<int> selectedIds;
  final String emptyText;
  final double selectionBottomInset;
  final ValueChanged<_RecordingPreview> onOpenItem;
  final ValueChanged<_RecordingPreview> onLongPressItem;
  final ValueChanged<_RecordingPreview> onToggleSelection;
  final ValueChanged<_RecordingPreview> onMorePressed;

  @override
  Widget build(BuildContext context) {
    switch (mode) {
      case _HomeViewMode.loading:
        return const Center(child: CircularProgressIndicator());
      case _HomeViewMode.empty:
        return LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            return SingleChildScrollView(
              physics: const ClampingScrollPhysics(),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minWidth: constraints.maxWidth,
                  minHeight: constraints.maxHeight,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 72),
                  child: _HomeEmptyState(palette: palette, text: emptyText),
                ),
              ),
            );
          },
        );
      case _HomeViewMode.selection:
      case _HomeViewMode.normal:
        final bool showSelection = mode == _HomeViewMode.selection;
        return SingleChildScrollView(
          physics: const ClampingScrollPhysics(),
          padding: EdgeInsets.fromLTRB(
            0,
            0,
            0,
            showSelection
                ? selectionBottomInset
                : HomePageMetrics.listBottomInset,
          ),
          child: GooList.builder(
            itemCount: items.length,
            backgroundColor: palette.surface,
            itemBuilder: (BuildContext context, int index) {
              final _RecordingPreview item = items[index];
              return _HomeListRow(
                item: item,
                selected: selectedIds.contains(item.id),
                selectionMode: showSelection,
                onTap: () {
                  if (showSelection) {
                    onToggleSelection(item);
                    return;
                  }
                  onOpenItem(item);
                },
                onLongPress: () {
                  if (showSelection) {
                    onToggleSelection(item);
                    return;
                  }
                  onLongPressItem(item);
                },
                onMorePressed: () => onMorePressed(item),
              );
            },
          ),
        );
    }
  }
}

class _HomeListRow extends StatelessWidget implements GooListRowChild {
  const _HomeListRow({
    required this.item,
    required this.selected,
    required this.selectionMode,
    required this.onTap,
    required this.onLongPress,
    required this.onMorePressed,
    this.showDivider = true,
    this.padding,
    this.minHeight,
  });

  final _RecordingPreview item;
  final bool selected;
  final bool selectionMode;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final VoidCallback onMorePressed;
  final bool showDivider;
  final EdgeInsetsGeometry? padding;
  final double? minHeight;

  @override
  Widget copyWithListRow({
    bool? showDivider,
    EdgeInsetsGeometry? padding,
    double? minHeight,
    GooListStyle? listStyle,
    GooListRowPosition? rowPosition,
  }) {
    return _HomeListRow(
      item: item,
      selected: selected,
      selectionMode: selectionMode,
      onTap: onTap,
      onLongPress: onLongPress,
      onMorePressed: onMorePressed,
      showDivider: showDivider ?? this.showDivider,
      padding: padding ?? this.padding,
      minHeight: minHeight ?? this.minHeight,
    );
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onLongPress: onLongPress,
      child: GooListItem(
        title: item.title,
        subtitle: '${item.duration} · ${item.date}',
        leadingIconName: item.favorite ? 'file-heart' : 'file-audio',
        leadingIconTone: item.favorite
            ? GooListIconTone.red
            : GooListIconTone.blue,
        trailing: selectionMode
            ? GooCheckbox(
                checked: selected,
                onCheckedChange: (_) => onTap(),
                semanticLabel: '选择 ${item.title}',
              )
            : _MoreButton(onPressed: onMorePressed),
        onTap: onTap,
        selected: selected,
        pressed: selected,
        showDivider: showDivider,
        padding: padding,
        minHeight: minHeight ?? HomePageMetrics.rowHeight,
        semanticLabel: '${item.title}，${item.duration}，${item.date}',
      ),
    );
  }
}

class _MoreButton extends StatelessWidget {
  const _MoreButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return GooActionIcon(
      iconName: 'ellipsis',
      semanticLabel: '更多操作',
      size: GooActionIconSize.standard,
      onPressed: onPressed,
    );
  }
}

class _ActionSheetItem extends StatelessWidget {
  const _ActionSheetItem({
    required this.palette,
    required this.icon,
    required this.label,
    required this.enabled,
    required this.onTap,
  });

  final HomePagePalette palette;
  final IconData icon;
  final String label;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: HomePageMetrics.actionSheetOptionHorizontal,
              vertical: HomePageMetrics.actionSheetOptionVertical,
            ),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: HomePageMetrics.actionSheetOptionIconBox,
                  height: HomePageMetrics.actionSheetOptionIconBox,
                  child: Center(
                    child: Icon(icon, size: 18, color: palette.text),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    style: HomePageTextStyles.actionSheetOption(palette),
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

class _MoveGroupSheet extends StatelessWidget {
  const _MoveGroupSheet({required this.title, required this.folders});

  final String title;
  final List<String> folders;

  @override
  Widget build(BuildContext context) {
    final HomePagePalette palette = HomePagePalette.of(context);
    final List<_HomeTabSpec> targets = <_HomeTabSpec>[
      const _HomeTabSpec(id: _meetingTab, label: '会议音频'),
      ...folders.map((String name) => _HomeTabSpec(id: name, label: name)),
    ];
    final double bottomInset = MediaQuery.of(context).padding.bottom;

    return SafeArea(
      top: false,
      child: Align(
        alignment: Alignment.bottomCenter,
        child: Container(
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: const BorderRadius.vertical(
              top: Radius.circular(HomePageMetrics.actionSheetRadius),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  HomePageMetrics.actionSheetHeaderHorizontal,
                  HomePageMetrics.actionSheetHeaderTop,
                  HomePageMetrics.actionSheetHeaderHorizontal,
                  HomePageMetrics.actionSheetHeaderBottom,
                ),
                child: Column(
                  children: <Widget>[
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: HomePageTextStyles.actionSheetTitle(palette),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '选择目标分组',
                      style: HomePageTextStyles.emptyText(
                        palette,
                      ).copyWith(fontSize: 13),
                    ),
                  ],
                ),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 320),
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: targets.length + 1,
                  separatorBuilder: (BuildContext context, int index) =>
                      Divider(height: 1, color: palette.divider),
                  itemBuilder: (BuildContext context, int index) {
                    if (index == targets.length) {
                      return _ActionSheetItem(
                        palette: palette,
                        icon: LucideIcons.plus300,
                        label: '新建分组',
                        enabled: true,
                        onTap: () => Navigator.of(context).pop('__create__'),
                      );
                    }

                    final _HomeTabSpec target = targets[index];
                    return _ActionSheetItem(
                      palette: palette,
                      icon: target.id == _meetingTab
                          ? LucideIcons.users300
                          : LucideIcons.folder300,
                      label: target.label,
                      enabled: true,
                      onTap: () => Navigator.of(context).pop(target.id),
                    );
                  },
                ),
              ),
              Divider(height: 1, color: palette.divider),
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: HomePageMetrics.actionSheetHeaderHorizontal,
                    vertical: HomePageMetrics.actionSheetCancelVertical,
                  ),
                  minimumSize: const Size.fromHeight(0),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Center(
                  child: Text(
                    '取消',
                    style: HomePageTextStyles.actionSheetCancel(palette),
                  ),
                ),
              ),
              SizedBox(height: bottomInset),
            ],
          ),
        ),
      ),
    );
  }
}

class _HomeEmptyState extends StatelessWidget {
  const _HomeEmptyState({required this.palette, required this.text});

  final HomePagePalette palette;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 128, 24, 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          SizedBox(
            width: HomePageMetrics.emptyIconSize,
            height: HomePageMetrics.emptyIconSize,
            child: Icon(
              LucideIcons.cassetteTape200,
              size: HomePageMetrics.emptyIconSize,
              color: palette.mutedText,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            text,
            textAlign: TextAlign.center,
            style: HomePageTextStyles.emptyText(palette),
          ),
        ],
      ),
    );
  }
}

class _RecordFab extends StatelessWidget {
  const _RecordFab({required this.palette, required this.onPressed});

  final HomePagePalette palette;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(20),
        child: Ink(
          width: HomePageMetrics.fabSize,
          height: HomePageMetrics.fabSize,
          decoration: BoxDecoration(
            color: palette.fab,
            borderRadius: BorderRadius.all(
              Radius.circular(HomePageMetrics.fabRadius),
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: palette.fabShadow,
                blurRadius: 14,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: const Icon(LucideIcons.mic300, size: 32, color: Colors.white),
        ),
      ),
    );
  }
}

class _HomeTabSpec {
  const _HomeTabSpec({required this.id, required this.label});

  final String id;
  final String label;
}

class _RecordingPreview {
  const _RecordingPreview({
    required this.id,
    required this.filePath,
    required this.title,
    this.groupName,
    required this.durationMs,
    required this.createdAtMs,
    required this.duration,
    required this.date,
    this.favorite = false,
  });

  factory _RecordingPreview.fromEntity(RecordingEntity entity) {
    return _RecordingPreview(
      id: entity.id,
      filePath: entity.filePath,
      title: _titleFromEntity(entity),
      groupName: entity.groupName?.trim(),
      durationMs: entity.durationMs,
      createdAtMs: entity.createdAtMs,
      duration: entity.durationMs > 0
          ? formatDurationMs(entity.durationMs)
          : '未知时长',
      date: _formatDate(entity.createdAtMs),
      favorite: entity.isFavorite,
    );
  }

  final int id;
  final String filePath;
  final String title;
  final String? groupName;
  final int durationMs;
  final int createdAtMs;
  final String duration;
  final String date;
  final bool favorite;

  _RecordingPreview copyWith({
    String? title,
    String? groupName,
    String? duration,
    String? date,
    bool? favorite,
  }) {
    return _RecordingPreview(
      id: id,
      filePath: filePath,
      title: title ?? this.title,
      groupName: groupName ?? this.groupName,
      durationMs: durationMs,
      createdAtMs: createdAtMs,
      duration: duration ?? this.duration,
      date: date ?? this.date,
      favorite: favorite ?? this.favorite,
    );
  }
}

String _titleFromEntity(RecordingEntity entity) {
  final String displayName = entity.displayName?.trim() ?? '';
  if (displayName.isNotEmpty) {
    return displayName;
  }
  return _titleFromPath(entity.filePath, entity.id);
}

String _titleFromPath(String filePath, int id) {
  final String filename = p.basenameWithoutExtension(filePath).trim();
  if (filename.isNotEmpty) {
    return filename;
  }
  return '录音-$id';
}

String _formatDate(int createdAtMs) {
  final DateTime time = DateTime.fromMillisecondsSinceEpoch(createdAtMs);
  final String year = time.year.toString().padLeft(4, '0');
  final String month = time.month.toString().padLeft(2, '0');
  final String day = time.day.toString().padLeft(2, '0');
  final String hour = time.hour.toString().padLeft(2, '0');
  final String minute = time.minute.toString().padLeft(2, '0');
  return '$year-$month-$day $hour:$minute';
}
