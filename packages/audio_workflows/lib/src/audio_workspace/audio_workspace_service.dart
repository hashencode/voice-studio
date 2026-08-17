import 'dart:convert';

import 'audio_workspace_models.dart';
import 'audio_workspace_port.dart';

class AudioWorkspaceService {
  const AudioWorkspaceService({required AudioWorkspacePort port})
    : _port = port;

  final AudioWorkspacePort _port;

  Future<List<AudioWorkspaceSummary>> listAudios({
    String query = '',
    int limit = 200,
    int offset = 0,
  }) {
    if (limit < 1 || limit > 500 || offset < 0) {
      throw ArgumentError('audio library window is invalid');
    }
    return _port.listAudios(query: query.trim(), limit: limit, offset: offset);
  }

  Future<AudioWorkspaceSnapshot?> openAudio(int recordingId) {
    if (recordingId <= 0) throw ArgumentError.value(recordingId);
    return _port.openAudio(recordingId);
  }

  Future<List<AudioWorkspaceSegment>> searchTranscript({
    required int recordingId,
    required String query,
    int? startMs,
    int? endMs,
    int? speakerId,
    int limit = 200,
  }) {
    final normalized = query.trim();
    if (normalized.isEmpty) return Future.value(const []);
    if (recordingId <= 0 ||
        limit < 1 ||
        limit > 500 ||
        startMs != null && startMs < 0 ||
        endMs != null && endMs < 0 ||
        startMs != null && endMs != null && endMs <= startMs) {
      throw ArgumentError('transcript search bounds are invalid');
    }
    return _port.searchTranscript(
      recordingId: recordingId,
      query: normalized,
      startMs: startMs,
      endMs: endMs,
      speakerId: speakerId,
      limit: limit,
    );
  }

  Future<bool> saveSegment({
    required int segmentId,
    required String text,
    AudioWorkspaceReviewState reviewState = AudioWorkspaceReviewState.reviewed,
  }) {
    final normalized = text.trim();
    if (segmentId <= 0 || normalized.isEmpty) {
      throw ArgumentError('reviewed transcript text is invalid');
    }
    return _port.saveSegment(
      segmentId: segmentId,
      text: normalized,
      reviewState: reviewState,
    );
  }

  Future<bool> undo(int generationId) => _port.undo(generationId);

  Future<bool> redo(int generationId) => _port.redo(generationId);

  Future<void> renameSpeakers(Map<int, String> names) {
    final normalized = <int, String>{};
    for (final entry in names.entries) {
      final name = entry.value.trim();
      if (entry.key <= 0 || name.isEmpty || name.runes.length > 120) {
        throw ArgumentError('speaker rename batch is invalid');
      }
      normalized[entry.key] = name;
    }
    return _port.renameSpeakers(normalized);
  }

  Future<void> mergeSpeakers({
    required int generationId,
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) {
    final sources = sourceSpeakerIds
        .where((id) => id > 0 && id != targetSpeakerId)
        .toSet();
    if (generationId <= 0 || targetSpeakerId <= 0 || sources.isEmpty) {
      throw ArgumentError('speaker merge selection is invalid');
    }
    return _port.mergeSpeakers(
      generationId: generationId,
      targetSpeakerId: targetSpeakerId,
      sourceSpeakerIds: sources,
    );
  }

  Future<void> assignSpeaker({
    required int generationId,
    required int segmentId,
    required int? speakerId,
    required AudioWorkspaceSpeakerState state,
  }) {
    if (generationId <= 0 ||
        segmentId <= 0 ||
        state == AudioWorkspaceSpeakerState.assigned && speakerId == null ||
        state != AudioWorkspaceSpeakerState.assigned && speakerId != null) {
      throw ArgumentError('manual speaker assignment is invalid');
    }
    return _port.assignSpeaker(
      generationId: generationId,
      segmentId: segmentId,
      speakerId: speakerId,
      state: state,
    );
  }

  AudioWorkspaceExport export(
    AudioWorkspaceSnapshot workspace,
    AudioWorkspaceExportFormat format,
  ) {
    return switch (format) {
      AudioWorkspaceExportFormat.text => AudioWorkspaceExport(
        format: format,
        fileExtension: 'txt',
        mimeType: 'text/plain',
        contents: _plainText(workspace),
      ),
      AudioWorkspaceExportFormat.markdown => AudioWorkspaceExport(
        format: format,
        fileExtension: 'md',
        mimeType: 'text/markdown',
        contents: _markdown(workspace),
      ),
      AudioWorkspaceExportFormat.webVtt => AudioWorkspaceExport(
        format: format,
        fileExtension: 'vtt',
        mimeType: 'text/vtt',
        contents: _timed(workspace, webVtt: true),
      ),
      AudioWorkspaceExportFormat.srt => AudioWorkspaceExport(
        format: format,
        fileExtension: 'srt',
        mimeType: 'application/x-subrip',
        contents: _timed(workspace, webVtt: false),
      ),
      AudioWorkspaceExportFormat.json => AudioWorkspaceExport(
        format: format,
        fileExtension: 'json',
        mimeType: 'application/json',
        contents:
            '${const JsonEncoder.withIndent('  ').convert(_json(workspace))}\n',
      ),
    };
  }

  String _plainText(AudioWorkspaceSnapshot workspace) => workspace.segments
      .map((segment) => '${_speaker(segment)}：${segment.text}')
      .join('\n');

  String _markdown(AudioWorkspaceSnapshot workspace) {
    final buffer = StringBuffer('# ${workspace.summary.displayName}\n\n');
    for (final segment in workspace.segments) {
      buffer.writeln(
        '- **${_speaker(segment)} · ${_clock(segment.startMs)}** '
        '${segment.text}',
      );
    }
    if (workspace.insights.isNotEmpty) {
      buffer.writeln('\n## 音频笔记\n');
      for (final insight in workspace.insights) {
        buffer.writeln('- **${insight.kind}** ${insight.body}');
      }
    }
    return buffer.toString();
  }

  String _timed(AudioWorkspaceSnapshot workspace, {required bool webVtt}) {
    final buffer = StringBuffer(webVtt ? 'WEBVTT\n\n' : '');
    for (var index = 0; index < workspace.segments.length; index += 1) {
      final segment = workspace.segments[index];
      buffer
        ..writeln(index + 1)
        ..writeln(
          '${_timestamp(segment.startMs, webVtt: webVtt)} --> '
          '${_timestamp(segment.endMs, webVtt: webVtt)}',
        )
        ..writeln('<v ${_speaker(segment)}>${segment.text}')
        ..writeln();
    }
    return buffer.toString();
  }

  Map<String, Object?> _json(AudioWorkspaceSnapshot workspace) => {
    'schemaVersion': 1,
    'recording': {
      'id': workspace.summary.recordingId,
      'displayName': workspace.summary.displayName,
      'durationMs': workspace.summary.durationMs,
      'generationId': workspace.summary.generationId,
    },
    'segments': workspace.segments
        .map(
          (segment) => {
            'id': segment.id,
            'sequenceId': segment.sequenceId,
            'startMs': segment.startMs,
            'endMs': segment.endMs,
            'text': segment.text,
            'reviewState': segment.reviewState.name,
            'speakerState': segment.speakerState.name,
            'speakerId': segment.speakerId,
            'speakerName': segment.speakerName,
          },
        )
        .toList(),
    'insights': workspace.insights
        .map(
          (insight) => {
            'id': insight.id,
            'kind': insight.kind,
            'body': insight.body,
            'status': insight.status,
            'evidenceSegmentIds': insight.evidenceSegmentIds,
          },
        )
        .toList(),
  };

  String _speaker(AudioWorkspaceSegment segment) =>
      switch (segment.speakerState) {
        AudioWorkspaceSpeakerState.overlap => '多人重叠',
        AudioWorkspaceSpeakerState.unknown => '未知说话人',
        AudioWorkspaceSpeakerState.assigned => segment.speakerName ?? '匿名说话人',
      };

  String _clock(int milliseconds) {
    final seconds = milliseconds ~/ 1000;
    final hours = seconds ~/ 3600;
    final minutes = (seconds % 3600) ~/ 60;
    final rest = seconds % 60;
    return hours > 0
        ? '${hours.toString().padLeft(2, '0')}:'
              '${minutes.toString().padLeft(2, '0')}:'
              '${rest.toString().padLeft(2, '0')}'
        : '${minutes.toString().padLeft(2, '0')}:'
              '${rest.toString().padLeft(2, '0')}';
  }

  String _timestamp(int milliseconds, {required bool webVtt}) {
    final hours = milliseconds ~/ 3600000;
    final minutes = (milliseconds % 3600000) ~/ 60000;
    final seconds = (milliseconds % 60000) ~/ 1000;
    final millis = milliseconds % 1000;
    return '${hours.toString().padLeft(2, '0')}:'
        '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}'
        '${webVtt ? '.' : ','}${millis.toString().padLeft(3, '0')}';
  }
}
