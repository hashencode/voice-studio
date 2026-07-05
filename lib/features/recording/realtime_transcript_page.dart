import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:path/path.dart' as p;

import '../shared/utils/formatters.dart';
import '../transcription/model/transcript_segment_entity.dart';
import '../transcription/repository/transcript_segments_repository.dart';

class RealtimeTranscriptPage extends StatefulWidget {
  const RealtimeTranscriptPage({super.key});

  @override
  State<RealtimeTranscriptPage> createState() => _RealtimeTranscriptPageState();
}

class _RealtimeTranscriptPageState extends State<RealtimeTranscriptPage> {
  final TranscriptSegmentsRepository _repository =
      TranscriptSegmentsRepository();

  bool _loading = true;
  List<TranscriptSegmentEntity> _segments = const <TranscriptSegmentEntity>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
    });
    final List<TranscriptSegmentEntity> segments = await _repository.listRecent(
      limit: 80,
    );
    if (!mounted) return;
    setState(() {
      _segments = segments;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
          children: <Widget>[
            Row(
              children: <Widget>[
                const Expanded(
                  child: GooText('实时转写', variant: GooTextVariant.heading),
                ),
                IconButton(
                  onPressed: _load,
                  icon: const Icon(Icons.refresh),
                  tooltip: '刷新',
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (_loading)
              const Padding(
                padding: EdgeInsets.only(top: 80),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_segments.isEmpty)
              const _RealtimeEmptyState()
            else
              GooList(
                style: GooListStyle.grouped,
                children: _segments.map(_buildSegmentItem).toList(),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildSegmentItem(TranscriptSegmentEntity segment) {
    final String fileName = segment.recordingPath.trim().isEmpty
        ? '实时录音'
        : p.basename(segment.recordingPath);
    final String timeline =
        '${formatDurationMs(segment.startMs)} - ${formatDurationMs(segment.endMs)}';
    return GooListItem(
      title: segment.text,
      subtitle: '$fileName\n$timeline · ${segment.source}',
      leadingIconName: 'captions',
    );
  }
}

class _RealtimeEmptyState extends StatelessWidget {
  const _RealtimeEmptyState();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 96),
      child: Column(
        children: const <Widget>[
          Icon(Icons.closed_caption_off_outlined, size: 42),
          SizedBox(height: 12),
          GooText('暂无实时片段', variant: GooTextVariant.subtitle),
        ],
      ),
    );
  }
}
