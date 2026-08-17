import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import '../service/meeting_import_service.dart';

class ImportProgressPanel extends StatefulWidget {
  const ImportProgressPanel({
    super.key,
    required this.service,
    required this.onCancel,
    required this.onCompleted,
    this.scrollController,
  });

  final MeetingImportService service;
  final VoidCallback onCancel;
  final ValueChanged<MeetingImportOutcome> onCompleted;
  final ScrollController? scrollController;

  @override
  State<ImportProgressPanel> createState() => _ImportProgressPanelState();
}

class _ImportProgressPanelState extends State<ImportProgressPanel> {
  bool _busy = false;
  MeetingImportOutcome? _outcome;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _pick());
  }

  Future<void> _pick() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _outcome = null;
      _error = null;
    });
    try {
      final outcome = await widget.service.pickAndImport();
      if (!mounted) return;
      if (outcome == null) {
        widget.onCancel();
        return;
      }
      setState(() {
        _busy = false;
        _outcome = outcome;
      });
    } on MeetingImportException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.message;
      });
    }
  }

  Future<void> _cancel() async {
    if (_busy) {
      await widget.service.cancelImport();
    }
    if (mounted) {
      widget.onCancel();
    }
  }

  @override
  Widget build(BuildContext context) {
    final outcome = _outcome;
    final files = <GooUploadFile>[
      if (_busy)
        const GooUploadFile(
          id: 'active-import',
          name: '正在复制所选媒体',
          kind: GooUploadFileKind.audio,
          status: GooUploadStatus.processing,
          canRemove: false,
          canRetry: false,
        )
      else if (outcome != null)
        GooUploadFile(
          id: outcome.candidate.fingerprintSha256,
          name: outcome.candidate.displayName,
          sizeLabel: _formatBytes(outcome.candidate.sizeBytes),
          mimeType: outcome.candidate.mimeType,
          kind: outcome.candidate.mimeType?.startsWith('video/') == true
              ? GooUploadFileKind.video
              : GooUploadFileKind.audio,
          status: GooUploadStatus.uploaded,
          warningText: outcome.inserted ? null : '该媒体已存在，未重复创建记录。',
          canRemove: false,
          canRetry: false,
        ),
    ];

    return SingleChildScrollView(
      controller: widget.scrollController,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          GooUpload(
            enabled: !_busy,
            files: files,
            title: _busy ? '正在导入到本机' : '选择会议媒体',
            description: '支持含音轨的音频或视频；内容只复制到本机。',
            helperText: '系统会验证真实音轨，不依赖文件名或扩展名。',
            limitsText: '单个文件不超过 2 GiB，时长不超过 4 小时。',
            errorText: _error,
            actions: <GooUploadAction>[
              GooUploadAction(
                label: _error == null ? '重新选择' : '重试',
                iconName: GooIcons.attachment,
                disabled: _busy || outcome != null,
                onPressed: _busy || outcome != null ? null : _pick,
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_busy) ...<Widget>[
            const GooButton.loading(disabled: true, child: Text('导入处理中')),
            const SizedBox(height: 8),
            GooButton.text(onPressed: _cancel, child: const Text('取消导入')),
          ] else if (outcome != null)
            GooButton(
              variant: GooButtonVariant.success,
              onPressed: () => widget.onCompleted(outcome),
              child: const Text('完成'),
            )
          else
            GooButton.text(onPressed: _cancel, child: const Text('取消')),
        ],
      ),
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GiB';
  }
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MiB';
  }
  if (bytes >= 1024) {
    return '${(bytes / 1024).toStringAsFixed(1)} KiB';
  }
  return '$bytes B';
}
