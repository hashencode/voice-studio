import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../settings/repository/app_settings_repository.dart';
import '../shared/utils/formatters.dart';
import '../shared/widgets/build_info_footer.dart';
import '../shared/widgets/common_empty_state.dart';
import 'model/transcription_job_entity.dart';
import 'repository/transcription_jobs_repository.dart';
import 'service/android_transcription_service.dart';
import 'service/fake_transcription_service.dart';
import 'service/transcription_port.dart';

class TranscriptionPage extends StatefulWidget {
  const TranscriptionPage({super.key});

  @override
  State<TranscriptionPage> createState() => _TranscriptionPageState();
}

class _TranscriptionPageState extends State<TranscriptionPage> {
  final TranscriptionJobsRepository _repository = TranscriptionJobsRepository();
  final AppSettingsRepository _settingsRepository = AppSettingsRepository();
  late final TranscriptionPort _service;

  List<TranscriptionJobEntity> _jobs = <TranscriptionJobEntity>[];
  bool _loading = true;
  final Set<int> _retrying = <int>{};

  @override
  void initState() {
    super.initState();
    _service = _buildService();
    _load();
  }

  TranscriptionPort _buildService() {
    if (defaultTargetPlatform == TargetPlatform.android) {
      return AndroidTranscriptionService();
    }
    return FakeTranscriptionService();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
    });
    final jobs = await _repository.listRecent();
    if (!mounted) return;
    setState(() {
      _jobs = jobs;
      _loading = false;
    });
  }

  Future<void> _retryJob(int id) async {
    if (_retrying.contains(id)) return;

    setState(() {
      _retrying.add(id);
    });

    final messenger = ScaffoldMessenger.of(context);

    try {
      final job = await _repository.findById(id);
      if (job == null) {
        messenger.showSnackBar(const SnackBar(content: Text('任务不存在或已被删除')));
        return;
      }

      await _repository.updateStatus(
        id: id,
        status: 'processing',
        errorMessage: null,
      );

      final text = await _service.transcribe(
        TranscriptionRequest(
          recordingPath: job.recordingPath,
          durationMs: job.durationMs,
          modelId: (await _settingsRepository.load()).modelId,
        ),
      );

      await _repository.updateStatus(
        id: id,
        status: 'completed',
        resultText: text,
        errorMessage: null,
      );

      messenger.showSnackBar(SnackBar(content: Text('任务 #$id 重试成功')));
    } catch (e) {
      await _repository.updateStatus(
        id: id,
        status: 'failed',
        errorMessage: e.toString(),
      );
      messenger.showSnackBar(SnackBar(content: Text('任务 #$id 重试失败: $e')));
    } finally {
      if (mounted) {
        setState(() {
          _retrying.remove(id);
        });
      }
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('转写'),
        actions: <Widget>[
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _jobs.isEmpty
          ? const CommonEmptyState(
              icon: Icons.text_snippet_outlined,
              title: '暂无转写任务',
              description: '录音停止并保存后，会自动进入转写任务队列；也可在录音页关闭自动转写。',
            )
          : ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: _jobs.length,
              separatorBuilder: (BuildContext context, int index) =>
                  const SizedBox(height: 8),
              itemBuilder: (BuildContext context, int index) {
                final job = _jobs[index];
                final bool canRetry = job.status == 'failed';
                final bool isRetrying = _retrying.contains(job.id);

                return Card(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
                    child: ListTile(
                      leading: _StatusDot(status: job.status),
                      title: Text('任务 #${job.id}  ${_statusLabel(job.status)}'),
                      subtitle: Text(
                        _buildSubtitle(job),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: canRetry
                          ? TextButton(
                              onPressed: isRetrying
                                  ? null
                                  : () {
                                      _retryJob(job.id);
                                    },
                              child: Text(isRetrying ? '重试中...' : '重试'),
                            )
                          : null,
                    ),
                  ),
                );
              },
            ),
      bottomNavigationBar: const SafeArea(top: false, child: BuildInfoFooter()),
    );
  }

  String _statusLabel(String status) {
    switch (status) {
      case 'pending':
        return '待处理';
      case 'processing':
        return '处理中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return status;
    }
  }

  String _buildSubtitle(TranscriptionJobEntity job) {
    final String primary =
        job.resultText ?? job.errorMessage ?? job.recordingPath;
    final String updated = DateTime.fromMillisecondsSinceEpoch(
      job.updatedAtMs,
    ).toString();
    return '$primary\n${_modeLabel(job)} · 更新于: $updated · 时长: ${formatDurationMs(job.durationMs)}';
  }

  String _modeLabel(TranscriptionJobEntity job) {
    final String mode = switch (job.recordingMode) {
      'realtime' => '实时',
      'standard' => '标准',
      _ => job.recordingMode,
    };
    final String source = switch (job.source) {
      'standard_offline' => '离线全文',
      'realtime_final' => '实时分段',
      'realtime_fallback_offline' => '实时兜底离线',
      _ => job.source,
    };
    return '$mode · $source';
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final Color color;
    switch (status) {
      case 'pending':
        color = Colors.orange;
        break;
      case 'processing':
        color = Colors.blue;
        break;
      case 'completed':
        color = Colors.green;
        break;
      case 'failed':
        color = Colors.red;
        break;
      default:
        color = Colors.grey;
    }

    return CircleAvatar(
      radius: 12,
      backgroundColor: color.withValues(alpha: 0.16),
      child: Icon(Icons.brightness_1, size: 10, color: color),
    );
  }
}
