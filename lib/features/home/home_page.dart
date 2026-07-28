import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:path/path.dart' as p;

import '../../app/theme/theme_mode_controller.dart';
import '../importing/service/meeting_import_service.dart';
import '../importing/widgets/import_progress_panel.dart';
import '../meetings/service/meeting_export_service.dart';
import '../records/service/meeting_deletion_coordinator.dart';
import '../records/service/meeting_batch_operation_service.dart';
import '../records/service/meeting_share_service.dart';
import 'model/folder_entity.dart';
import 'repository/folders_repository.dart';
import '../records/model/recording_entity.dart';
import '../records/repository/recordings_repository.dart';
import '../records/widgets/recording_details_sheet.dart';
import '../recording/service/recording_startup_reconciler.dart';
import '../shared/utils/formatters.dart';
import '../transcription/model/transcription_job_entity.dart';
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
    this.recordingStartupReconciler,
    this.meetingImportService,
    this.meetingDeletionCoordinator,
    this.meetingShareService,
    this.meetingBatchOperationService,
    this.retryRecordings,
  });

  final RecordingsRepository? recordingsRepository;
  final FoldersRepository? foldersRepository;
  final TranscriptionJobsRepository? transcriptionJobsRepository;
  final TranscriptSegmentsRepository? transcriptSegmentsRepository;
  final RecordingStartupReconciler? recordingStartupReconciler;
  final MeetingImportService? meetingImportService;
  final MeetingDeletionCoordinator? meetingDeletionCoordinator;
  final MeetingShareService? meetingShareService;
  final MeetingBatchOperationService? meetingBatchOperationService;
  final RetryRecordings? retryRecordings;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  late final RecordingsRepository _repository;
  late final FoldersRepository _foldersRepository;
  late final TranscriptionJobsRepository _transcriptionJobsRepository;
  late final RecordingStartupReconciler _recordingStartupReconciler;
  late final MeetingImportService _meetingImportService;
  late final bool _ownsMeetingImportService;
  late final MeetingDeletionCoordinator _meetingDeletionCoordinator;
  late final MeetingShareService _meetingShareService;
  late final MeetingBatchOperationService _meetingBatchOperationService;
  StreamSubscription<void>? _sharedMediaSubscription;

  List<_RecordingPreview> _items = const <_RecordingPreview>[];
  List<FolderEntity> _folders = const <FolderEntity>[];
  late final GooSelectionController<int> _selectionController;
  late final TextEditingController _searchController;
  bool _loading = true;
  bool _recordingStartupReconciled = false;
  bool _handlingSharedImports = false;
  bool _sharedImportRescanRequested = false;
  int _loadEpoch = 0;
  String? _loadError;
  String _activeTab = _allTab;
  String _searchQuery = '';

  List<_HomeTabSpec> get _tabs => <_HomeTabSpec>[
    const _HomeTabSpec(id: _allTab, label: '全部音频'),
    const _HomeTabSpec(id: _meetingTab, label: '会议音频'),
    ..._folders.map(
      (FolderEntity folder) =>
          _HomeTabSpec(id: folder.name, label: folder.name),
    ),
    const _HomeTabSpec(id: _recentlyDeletedTab, label: '最近删除'),
  ];

  List<_RecordingPreview> get _visibleItems {
    final List<_RecordingPreview> tabItems = _items;
    final query = _normalizeSearchText(_searchQuery);
    if (query.isEmpty) return tabItems;
    return tabItems
        .where((item) => _normalizeSearchText(item.title).contains(query))
        .toList(growable: false);
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

  bool get _canToggleSelectAll => _visibleItems.isNotEmpty;
  String get _selectionTrailingLabel => _allVisibleSelected ? '取消全选' : '全选';
  bool get _canRenameSelection =>
      _activeTab != _recentlyDeletedTab && _selectedIds.length == 1;
  bool get _canDeleteSelection => _selectedIds.isNotEmpty;
  bool get _canMoveSelection =>
      _activeTab != _recentlyDeletedTab && _selectedIds.isNotEmpty;
  bool get _canRetrySelection =>
      _activeTab != _recentlyDeletedTab &&
      _visibleItems.any(
        (item) =>
            _selectedIds.contains(item.id) &&
            (item.latestJobStatus == 'failed' ||
                item.latestJobStatus == 'canceled'),
      );
  bool get _canExportSelection =>
      _activeTab != _recentlyDeletedTab && _selectedIds.isNotEmpty;

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
    _recordingStartupReconciler =
        widget.recordingStartupReconciler ?? RecordingStartupReconciler();
    _ownsMeetingImportService = widget.meetingImportService == null;
    _meetingImportService =
        widget.meetingImportService ?? MeetingImportService();
    _meetingDeletionCoordinator =
        widget.meetingDeletionCoordinator ?? MeetingDeletionCoordinator();
    _meetingShareService = widget.meetingShareService ?? MeetingShareService();
    _meetingBatchOperationService =
        widget.meetingBatchOperationService ??
        MeetingBatchOperationService(
          recordingsRepository: _repository,
          transcriptionJobsRepository: _transcriptionJobsRepository,
          transcriptSegmentsRepository:
              widget.transcriptSegmentsRepository ??
              TranscriptSegmentsRepository(),
          meetingDeletionCoordinator: _meetingDeletionCoordinator,
          retryRecordings: widget.retryRecordings,
        );
    _selectionController = GooSelectionController<int>(
      enableHapticFeedback: true,
    )..addListener(_handleSelectionChanged);
    _searchController = TextEditingController();
    unawaited(_meetingBatchOperationService.cleanupStaleArtifacts());
    _sharedMediaSubscription = _meetingImportService.sharedMediaAvailable
        .listen((_) => _requestSharedImportScan());
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _requestSharedImportScan();
    });
  }

  @override
  void dispose() {
    _sharedMediaSubscription?.cancel();
    if (_ownsMeetingImportService) {
      _meetingImportService.dispose();
    }
    _selectionController
      ..removeListener(_handleSelectionChanged)
      ..dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _requestSharedImportScan() {
    if (!mounted) return;
    if (_handlingSharedImports) {
      _sharedImportRescanRequested = true;
      return;
    }
    unawaited(_consumeSharedImports());
  }

  Future<void> _consumeSharedImports() async {
    if (_handlingSharedImports) return;
    _handlingSharedImports = true;
    try {
      while (mounted && await _meetingImportService.hasPendingSharedImport()) {
        if (!mounted) return;
        _showFeedback('正在导入分享的媒体…');
        final MeetingImportOutcome? outcome = await _meetingImportService
            .consumeSharedImport();
        if (outcome == null || !mounted) break;
        await _load();
        if (!mounted) return;
        _showFeedback(outcome.inserted ? '已从系统分享创建会议记录' : '该分享媒体已存在，未重复创建记录');
      }
    } on MeetingImportException catch (error) {
      if (mounted) {
        await _showMessageDialog(error.message);
      }
    } finally {
      _handlingSharedImports = false;
      if (_sharedImportRescanRequested && mounted) {
        _sharedImportRescanRequested = false;
        _requestSharedImportScan();
      }
    }
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
    final int loadEpoch = ++_loadEpoch;
    if (mounted) {
      setState(() {
        _loading = true;
        _loadError = null;
      });
    }

    try {
      if (!_recordingStartupReconciled) {
        try {
          await _recordingStartupReconciler.reconcile();
          _recordingStartupReconciled = true;
        } catch (_) {
          // A native reconciliation failure must not hide existing local data.
        }
      }
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
      Map<String, TranscriptionJobEntity> latestJobs =
          const <String, TranscriptionJobEntity>{};
      try {
        latestJobs = await _transcriptionJobsRepository
            .findLatestByRecordingPaths(
              records.map((RecordingEntity record) => record.filePath),
            );
      } catch (_) {
        // Transcription status is supplementary; never hide local recordings.
      }
      if (!mounted || loadEpoch != _loadEpoch) return;
      setState(() {
        _folders = folders;
        _items = records
            .map(
              (RecordingEntity record) => _RecordingPreview.fromEntity(
                record,
                latestJob: latestJobs[record.filePath],
              ),
            )
            .toList();
        _loading = false;
      });
      _reconcileSelectionWithVisibleItems(haptic: false);
    } catch (error) {
      if (!mounted || loadEpoch != _loadEpoch) return;
      setState(() {
        _folders = const <FolderEntity>[];
        _items = const <_RecordingPreview>[];
        _loading = false;
        _loadError = '列表加载失败，请稍后重试';
      });
      _selectionController.clearSelection(haptic: false);
      _showFeedback('列表加载失败，请稍后重试');
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

  void _searchTitles(String query) {
    final normalized = query.trim();
    if (_searchQuery == normalized) return;
    setState(() {
      _searchQuery = normalized;
    });
    _reconcileSelectionWithVisibleItems(haptic: false);
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

  void _showFeedback(String message) {
    GooSnackbarScope.maybeOf(context)?.show(message: message);
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
    if (item == null) {
      return;
    }
    await _openRenameDialog(item);
  }

  Future<void> _openRenameDialog(_RecordingPreview item) async {
    final TextEditingController controller = TextEditingController(
      text: item.title,
    );
    String? errorText;

    final String? nextName = await showGooDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            void submit() {
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
            }

            return GooDialog<String>.custom(
              title: '重命名文件',
              description: '只修改显示名称，不会修改原始文件名。',
              customContentCenterChild: false,
              actions: <GooDialogAction>[
                const GooDialogAction(label: '取消'),
                GooDialogAction(
                  label: '保存',
                  style: GooDialogActionStyle.primary,
                  closesDialog: false,
                  onPressed: submit,
                ),
              ],
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  GooInput(
                    controller: controller,
                    placeholder: '输入新的文件名',
                    error: errorText,
                    showClearButton: true,
                    onChanged: (_) {
                      if (errorText != null) {
                        setModalState(() {
                          errorText = null;
                        });
                      }
                    },
                    onSubmitted: (_) => submit(),
                  ),
                ],
              ),
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
    for (final _RecordingPreview entry in _items) {
      if (entry.id == itemId) continue;
      if (entry.title.trim().toLowerCase() == normalized) {
        return '名称已存在，请使用其他名称';
      }
    }
    return null;
  }

  Future<void> _renameItem(_RecordingPreview item, String displayName) async {
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
    _showFeedback('重命名成功');
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

    final String? nextName = await showGooDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            void submit() {
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
            }

            return GooDialog<String>.custom(
              title: '新建分组',
              customContentCenterChild: false,
              actions: <GooDialogAction>[
                const GooDialogAction(label: '取消'),
                GooDialogAction(
                  label: '创建',
                  style: GooDialogActionStyle.primary,
                  closesDialog: false,
                  onPressed: submit,
                ),
              ],
              child: GooInput(
                controller: controller,
                placeholder: '输入分组名称',
                error: errorText,
                showClearButton: true,
                onChanged: (_) {
                  if (errorText != null) {
                    setModalState(() {
                      errorText = null;
                    });
                  }
                },
                onSubmitted: (_) => submit(),
              ),
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
    _showFeedback('分组创建成功');
    await _load();
    return folderName;
  }

  Future<void> _moveItemToGroup(
    _RecordingPreview item, {
    required String targetGroup,
  }) async {
    final result = await _meetingBatchOperationService.move(<int>[
      item.id,
    ], targetGroup: targetGroup);
    if (!mounted) return;
    _showBatchFeedback('移动', result);
    await _load();
  }

  Future<void> _openMoveSheet(_RecordingPreview item) async {
    final String? targetGroup = await showGooPanel<String>(
      context: context,
      title: '移动“${item.title}”',
      semanticLabel: '${item.title} 移动分组',
      builder:
          (
            BuildContext context,
            GooPanelController<String> controller,
            ScrollController scrollController,
          ) {
            return _MoveGroupPanel(
              folders: _folders
                  .map((FolderEntity folder) => folder.name)
                  .toList(),
              controller: controller,
              scrollController: scrollController,
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

  Future<void> _openMoveSheetForSelection() async {
    if (!_canMoveSelection) return;
    final String? targetGroup = await showGooPanel<String>(
      context: context,
      title: '移动 ${_selectedIds.length} 条记录',
      semanticLabel: '批量移动分组',
      builder:
          (
            BuildContext context,
            GooPanelController<String> controller,
            ScrollController scrollController,
          ) {
            return _MoveGroupPanel(
              folders: _folders
                  .map((FolderEntity folder) => folder.name)
                  .toList(),
              controller: controller,
              scrollController: scrollController,
            );
          },
    );
    if (!mounted || targetGroup == null) return;
    String resolvedGroup = targetGroup;
    if (targetGroup == '__create__') {
      final created = await _createFolder();
      if (!mounted || created == null) return;
      resolvedGroup = created;
    }
    final result = await _meetingBatchOperationService.move(
      _selectedIds,
      targetGroup: resolvedGroup,
    );
    if (!mounted) return;
    _showBatchFeedback('移动', result);
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  Future<void> _retrySelected() async {
    if (!_canRetrySelection) return;
    final result = await _meetingBatchOperationService.retry(_selectedIds);
    if (!mounted) return;
    _showBatchFeedback('重试', result);
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  Future<void> _exportSelected() async {
    if (!_canExportSelection) return;
    final format = await showGooPanel<MeetingExportFormat>(
      context: context,
      title: '批量导出格式',
      semanticLabel: '选择批量导出格式',
      builder:
          (
            BuildContext context,
            GooPanelController<MeetingExportFormat> controller,
            ScrollController scrollController,
          ) {
            return _BatchExportFormatPanel(
              controller: controller,
              scrollController: scrollController,
            );
          },
    );
    if (!mounted || format == null) return;
    _showFeedback('正在生成批量导出…');
    final result = await _meetingBatchOperationService.export(
      _selectedIds,
      format: format,
    );
    if (!mounted) return;
    if (result.artifact == null) {
      _showBatchFeedback('导出', result);
      return;
    }
    try {
      await _meetingBatchOperationService.shareExport(result);
      if (!mounted) return;
      _showBatchFeedback('导出', result);
      _selectionController.clearSelection(haptic: false);
    } catch (_) {
      if (!mounted) return;
      await _showMessageDialog('批量导出已生成，但无法打开系统分享。临时文件已清理。');
    }
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
            iconName: GooIcons.recover,
          ),
          GooShareTarget(
            id: 'delete',
            label: '彻底删除',
            iconName: GooIcons.delete,
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
    final GooIconId favoriteIconName = item.favorite
        ? GooIcons.favoriteFill
        : GooIcons.favorite;
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
          iconName: GooIcons.rename,
        ),
        const GooShareTarget(
          id: 'move',
          label: '移动到',
          iconName: GooIcons.folder,
        ),
        GooShareTarget(
          id: 'favorite',
          label: favoriteLabel,
          iconName: favoriteIconName,
        ),
        const GooShareTarget(
          id: 'share',
          label: '分享',
          iconName: GooIcons.share,
        ),
        GooShareTarget(
          id: 'delete',
          label: '删除',
          iconName: GooIcons.delete,
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
    _showFeedback(nextFavorite ? '已收藏文件' : '已取消收藏文件');
  }

  Future<void> _openItem(_RecordingPreview item) async {
    TranscriptionJobEntity? latestJob;
    try {
      latestJob = await _transcriptionJobsRepository.findLatestByRecordingPath(
        item.filePath,
      );
    } catch (_) {
      // The recording remains usable even when supplementary status is absent.
    }
    if (!mounted) return;
    await showRecordingDetailsSheet(
      context: context,
      title: item.title,
      path: item.filePath,
      durationMs: item.durationMs,
      createdAtMs: item.createdAtMs,
      latestJob: latestJob,
      recordingId: item.id,
    );
  }

  Future<void> _shareItem(_RecordingPreview item) async {
    try {
      await _meetingShareService.share(
        recordingId: item.id,
        path: item.filePath,
        displayName: item.title,
      );
    } catch (error) {
      if (!mounted) return;
      await _showMessageDialog('无法打开系统分享，请确认文件仍存在。');
    }
  }

  Future<void> _importMeetingMedia() async {
    final outcome = await showGooPanel<MeetingImportOutcome?>(
      context: context,
      title: '导入会议媒体',
      useRootNavigator: true,
      enableBackdropDismiss: false,
      enableDragDismiss: false,
      builder:
          (
            BuildContext context,
            GooPanelController<MeetingImportOutcome?> panelController,
            ScrollController scrollController,
          ) {
            return ImportProgressPanel(
              service: _meetingImportService,
              onCancel: panelController.close,
              onCompleted: panelController.closeWithResult,
              scrollController: scrollController,
            );
          },
    );
    if (!mounted || outcome == null) return;
    await _load();
  }

  Future<void> _showMessageDialog(String message) {
    return showGooDialog<void>(
      context: context,
      builder: (BuildContext context) {
        return GooDialog<void>.confirmation(
          title: '提示',
          description: message,
          actions: const <GooDialogAction>[
            GooDialogAction(label: '知道了', style: GooDialogActionStyle.primary),
          ],
        );
      },
    );
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
    final bool isRecentlyDeleted = _activeTab == _recentlyDeletedTab;
    final String title = isRecentlyDeleted
        ? (items.length == 1 ? '确认彻底删除' : '批量彻底删除')
        : (items.length == 1 ? '确认删除' : '批量删除');
    final String description = isRecentlyDeleted
        ? (items.length == 1
              ? '删除后无法恢复，会同时清理关联转写数据。'
              : '删除后无法恢复，会同时清理 ${items.length} 条录音的关联转写数据。')
        : (items.length == 1
              ? '会将该录音移入最近删除。'
              : '会将 ${items.length} 条录音移入最近删除。');
    final String confirmLabel = isRecentlyDeleted ? '彻底删除' : '确认删除';
    final bool? confirmed = await showGooDialog<bool>(
      context: context,
      builder: (BuildContext context) {
        return GooDialog<bool>.confirmation(
          title: title,
          description: description,
          actions: <GooDialogAction>[
            const GooDialogAction(label: '取消', result: false),
            GooDialogAction(
              label: confirmLabel,
              result: true,
              style: GooDialogActionStyle.primary,
              tone: isRecentlyDeleted
                  ? GooDialogActionTone.destructive
                  : GooDialogActionTone.defaultStyle,
            ),
          ],
        );
      },
    );

    if (confirmed != true) return;

    final ids = items.map((item) => item.id);
    final result = isRecentlyDeleted
        ? await _meetingBatchOperationService.permanentlyDelete(ids)
        : await _meetingBatchOperationService.softDelete(ids);
    if (!mounted) return;
    _showBatchFeedback(isRecentlyDeleted ? '彻底删除' : '删除', result);
    if (isRecentlyDeleted &&
        result.items.any((item) => item.reason == 'deletion_pending')) {
      await _showMessageDialog('部分文件暂时无法删除，任务已保留，可稍后幂等重试。');
    }
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  void _showBatchFeedback(String action, MeetingBatchOperationResult result) {
    _showFeedback(
      '$action完成：成功 ${result.succeededCount}，'
      '跳过 ${result.skippedCount}，失败 ${result.failedCount}',
    );
  }

  Future<void> _restoreItems(List<_RecordingPreview> items) async {
    for (final _RecordingPreview item in items) {
      await _repository.restoreById(item.id);
    }
    if (!mounted) return;
    _showFeedback(items.length == 1 ? '已恢复' : '已恢复 ${items.length} 条记录');
    _selectionController.clearSelection(haptic: false);
    await _load();
  }

  String _emptyText() {
    if (_loadError != null) return _loadError!;
    if (_searchQuery.isNotEmpty) return '没有匹配的记录标题';
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
          iconName: GooIcons.upload,
          semanticLabel: _meetingImportService.isAvailable ? '导入' : '导入能力尚未配置',
          tooltip: _meetingImportService.isAvailable ? '导入' : '当前平台尚未配置真实导入能力',
          onPressed: _meetingImportService.isAvailable
              ? _importMeetingMedia
              : null,
        ),
        GooAppBarIconAction(
          iconName: themeController?.isDarkMode == true
              ? GooIcons.darkMode
              : GooIcons.sunny,
          semanticLabel: '主题',
          tooltip: '主题',
          onPressed: () => themeController?.toggle(),
        ),
        GooAppBarIconAction(
          iconName: GooIcons.settings,
          semanticLabel: '设置',
          tooltip: '设置',
          onPressed: () => Navigator.of(context).pushNamed('/settings'),
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
        iconName: GooIcons.rename,
        label: '重命名',
        semanticLabel: '重命名所选音频',
        onPressed: _canRenameSelection
            ? () {
                _openRenameDialogForSelection();
              }
            : null,
      ),
      GooToolBarItem(
        iconName: GooIcons.folder,
        label: '移动',
        semanticLabel: '移动所选音频',
        onPressed: _canMoveSelection ? _openMoveSheetForSelection : null,
      ),
      GooToolBarItem(
        iconName: GooIcons.refresh,
        label: '重试',
        semanticLabel: '重试所选转写任务',
        onPressed: _canRetrySelection ? _retrySelected : null,
      ),
      GooToolBarItem(
        iconName: GooIcons.download,
        label: '导出',
        semanticLabel: '导出所选会议转写',
        onPressed: _canExportSelection ? _exportSelected : null,
      ),
      GooToolBarItem(
        iconName: GooIcons.delete,
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
                  if (!_isSelectionMode)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        HomePageMetrics.horizontalPadding,
                        8,
                        HomePageMetrics.horizontalPadding,
                        8,
                      ),
                      child: GooSearchBar(
                        controller: _searchController,
                        mode: GooSearchBarMode.defaultBar,
                        activatedMode: GooSearchBarMode.activatedInstant,
                        placeholder: '搜索当前分组的记录标题',
                        showVoiceIcon: false,
                        onSearch: _searchTitles,
                        onClear: () => _searchTitles(''),
                        onCancel: () {
                          _searchController.clear();
                          _searchTitles('');
                        },
                      ),
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
            iconName: GooIcons.addFolder,
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
        return const Center(
          child: GooSpinner(semanticLabel: '正在加载会议记录', liveRegion: true),
        );
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
        subtitle: '${item.duration} · ${item.date} · ${item.lifecycleLabel}',
        leadingIconName: item.favorite
            ? GooIcons.favoriteFill
            : GooIcons.audioFiles,
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
        semanticLabel:
            '${item.title}，${item.duration}，${item.date}，${item.lifecycleLabel}',
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
      iconName: GooIcons.more,
      semanticLabel: '更多操作',
      size: GooActionIconSize.standard,
      onPressed: onPressed,
    );
  }
}

class _MoveGroupPanel extends StatelessWidget {
  const _MoveGroupPanel({
    required this.folders,
    required this.controller,
    required this.scrollController,
  });

  final List<String> folders;
  final GooPanelController<String> controller;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context) {
    final List<_HomeTabSpec> targets = <_HomeTabSpec>[
      const _HomeTabSpec(id: _meetingTab, label: '会议音频'),
      ...folders.map((String name) => _HomeTabSpec(id: name, label: name)),
    ];

    return ListView(
      controller: scrollController,
      padding: EdgeInsets.zero,
      children: <Widget>[
        const GooText('选择目标分组', variant: GooTextVariant.subtitle),
        const SizedBox(height: 12),
        GooList(
          style: GooListStyle.grouped,
          children: <Widget>[
            ...targets.map(
              (_HomeTabSpec target) => GooListItem(
                title: target.label,
                leadingIconName: target.id == _meetingTab
                    ? GooIcons.group
                    : GooIcons.folder,
                onTap: () => controller.closeWithResult(target.id),
              ),
            ),
            GooListItem(
              title: '新建分组',
              leadingIconName: GooIcons.addFolder,
              onTap: () => controller.closeWithResult('__create__'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        GooButton.text(onPressed: controller.close, child: const Text('取消')),
      ],
    );
  }
}

class _BatchExportFormatPanel extends StatelessWidget {
  const _BatchExportFormatPanel({
    required this.controller,
    required this.scrollController,
  });

  final GooPanelController<MeetingExportFormat> controller;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context) {
    return ListView(
      controller: scrollController,
      padding: EdgeInsets.zero,
      children: <Widget>[
        const GooText(
          '所有可导出记录使用同一种格式；不可导出的项目会写入清单。',
          variant: GooTextVariant.body,
        ),
        const SizedBox(height: 12),
        GooList(
          style: GooListStyle.grouped,
          children: MeetingExportFormat.values
              .map(
                (format) => GooListItem(
                  title: _exportFormatLabel(format),
                  subtitle: _exportFormatDescription(format),
                  leadingIconName: GooIcons.download,
                  onTap: () => controller.closeWithResult(format),
                ),
              )
              .toList(growable: false),
        ),
        const SizedBox(height: 12),
        GooButton.text(
          onPressed: controller.close,
          child: const GooText.inherit('取消'),
        ),
      ],
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
    required this.lifecycleLabel,
    this.latestJobStatus,
    this.favorite = false,
  });

  factory _RecordingPreview.fromEntity(
    RecordingEntity entity, {
    TranscriptionJobEntity? latestJob,
  }) {
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
      lifecycleLabel: _transcriptionLifecycleLabel(latestJob),
      latestJobStatus: latestJob?.status,
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
  final String lifecycleLabel;
  final String? latestJobStatus;
  final bool favorite;

  _RecordingPreview copyWith({
    String? title,
    String? groupName,
    String? duration,
    String? date,
    String? lifecycleLabel,
    String? latestJobStatus,
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
      lifecycleLabel: lifecycleLabel ?? this.lifecycleLabel,
      latestJobStatus: latestJobStatus ?? this.latestJobStatus,
      favorite: favorite ?? this.favorite,
    );
  }
}

String _transcriptionLifecycleLabel(TranscriptionJobEntity? job) {
  if (job == null) return '未转写';
  final progressPercent = ((job.progress ?? 0).clamp(0, 1) * 100).round();
  return switch (job.status) {
    'pending' => '待转写',
    'processing' => '转写中 $progressPercent%',
    'completed' => '转写完成',
    'failed' => '转写失败',
    'canceled' => '转写已取消',
    _ => '转写状态未知',
  };
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

String _normalizeSearchText(String value) {
  return value
      .trim()
      .toLowerCase()
      .split(RegExp(r'\s+', unicode: true))
      .where((part) => part.isNotEmpty)
      .join(' ');
}

String _exportFormatLabel(MeetingExportFormat format) {
  return switch (format) {
    MeetingExportFormat.text => '纯文本 TXT',
    MeetingExportFormat.markdown => 'Markdown',
    MeetingExportFormat.json => '结构化 JSON',
    MeetingExportFormat.srt => '字幕 SRT',
    MeetingExportFormat.vtt => '字幕 VTT',
  };
}

String _exportFormatDescription(MeetingExportFormat format) {
  return switch (format) {
    MeetingExportFormat.text => '只保留转写正文',
    MeetingExportFormat.markdown => '包含标题和时间范围',
    MeetingExportFormat.json => '包含片段字段与复核状态',
    MeetingExportFormat.srt => '适合常见字幕工具',
    MeetingExportFormat.vtt => '适合 Web 与标准字幕流程',
  };
}
