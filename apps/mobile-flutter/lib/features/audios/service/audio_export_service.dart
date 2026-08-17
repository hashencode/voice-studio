import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../../app/contracts/audio_contract.dart';
import '../../records/repository/recordings_repository.dart';
import '../../transcription/model/transcript_segment_entity.dart';
import '../model/audio_export_selection.dart';

enum AudioExportFormat { text, markdown, json, srt, vtt }

typedef AudioExportWriteProbe = Future<void> Function(IOSink sink);

class AudioExportReceipt {
  const AudioExportReceipt({
    required this.path,
    required this.format,
    required this.bytes,
  });

  final String path;
  final AudioExportFormat format;
  final int bytes;
}

class AudioExportService {
  AudioExportService({
    RecordingsRepository? recordingsRepository,
    Directory? exportDirectory,
    AudioExportWriteProbe? writeProbe,
  }) : _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _exportDirectory = exportDirectory,
       _writeProbe = writeProbe;

  final RecordingsRepository _recordingsRepository;
  final Directory? _exportDirectory;
  final AudioExportWriteProbe? _writeProbe;
  Future<void> _exportTail = Future<void>.value();

  Future<AudioExportReceipt> export({
    required int recordingId,
    required String title,
    required List<TranscriptSegmentEntity> segments,
    required AudioExportFormat format,
    AudioExportSelection selection = const AudioExportSelection.all(),
  }) {
    final previous = _exportTail;
    final completion = Completer<void>();
    _exportTail = completion.future;
    return previous
        .then(
          (_) => _export(
            recordingId: recordingId,
            title: title,
            segments: segments,
            format: format,
            selection: selection,
          ),
        )
        .whenComplete(completion.complete);
  }

  Future<AudioExportReceipt> exportToFile({
    required File destination,
    required String title,
    required List<TranscriptSegmentEntity> segments,
    required AudioExportFormat format,
    AudioExportSelection selection = const AudioExportSelection.all(),
  }) {
    final previous = _exportTail;
    final completion = Completer<void>();
    _exportTail = completion.future;
    return previous
        .then(
          (_) => _exportToFile(
            destination: destination,
            title: title,
            segments: segments,
            format: format,
            selection: selection,
          ),
        )
        .whenComplete(completion.complete);
  }

  Future<AudioExportReceipt> _export({
    required int recordingId,
    required String title,
    required List<TranscriptSegmentEntity> segments,
    required AudioExportFormat format,
    required AudioExportSelection selection,
  }) async {
    final selectedSegments = segments
        .where(
          (segment) => selection.intersects(
            startMs: segment.startMs,
            endMs: segment.endMs,
          ),
        )
        .toList(growable: false);
    if (selectedSegments.isEmpty) {
      throw StateError('所选范围没有可导出的转写片段');
    }
    final exportDirectory =
        _exportDirectory ??
        Directory(
          p.join(
            (await getApplicationSupportDirectory()).path,
            AudioContract.audioDirName,
            AudioContract.transcriptExportDirName,
          ),
        );
    await exportDirectory.create(recursive: true);
    final safeTitle = title
        .replaceAll(RegExp(r'[^\p{L}\p{N}._-]+', unicode: true), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    final extension = switch (format) {
      AudioExportFormat.text => 'txt',
      AudioExportFormat.markdown => 'md',
      AudioExportFormat.json => 'json',
      AudioExportFormat.srt => 'srt',
      AudioExportFormat.vtt => 'vtt',
    };
    final file = File(
      p.join(
        exportDirectory.path,
        '${safeTitle.isEmpty ? 'audio' : safeTitle}-$recordingId.$extension',
      ),
    );
    final temporary = File('${file.path}.partial');
    final backup = File('${file.path}.backup');
    if (await backup.exists()) {
      if (await file.exists()) {
        await backup.delete();
      } else {
        await backup.rename(file.path);
      }
    }
    if (await temporary.exists()) await temporary.delete();
    IOSink? sink;
    var renamed = false;
    var existingMoved = false;
    try {
      sink = temporary.openWrite();
      await _write(
        sink,
        title: title,
        segments: selectedSegments,
        format: format,
        selection: selection,
      );
      await _writeProbe?.call(sink);
      await sink.flush();
      await sink.close();
      sink = null;
      if (await file.exists()) {
        await file.rename(backup.path);
        existingMoved = true;
      }
      await temporary.rename(file.path);
      renamed = true;
      await _recordingsRepository.registerOwnedAsset(
        recordingId: recordingId,
        path: file.path,
        kind: 'transcript_export',
      );
      if (existingMoved && await backup.exists()) {
        await backup.delete();
      }
      return AudioExportReceipt(
        path: file.path,
        format: format,
        bytes: await file.length(),
      );
    } catch (_) {
      await _closeBestEffort(sink);
      if (await temporary.exists()) await temporary.delete();
      if (renamed && await file.exists()) await file.delete();
      if (existingMoved && await backup.exists()) {
        await backup.rename(file.path);
      }
      rethrow;
    }
  }

  Future<AudioExportReceipt> _exportToFile({
    required File destination,
    required String title,
    required List<TranscriptSegmentEntity> segments,
    required AudioExportFormat format,
    required AudioExportSelection selection,
  }) async {
    final selectedSegments = segments
        .where(
          (segment) => selection.intersects(
            startMs: segment.startMs,
            endMs: segment.endMs,
          ),
        )
        .toList(growable: false);
    if (selectedSegments.isEmpty) {
      throw StateError('所选范围没有可导出的转写片段');
    }
    await destination.parent.create(recursive: true);
    if (await destination.exists()) {
      throw StateError('导出目标已存在');
    }
    final temporary = File('${destination.path}.partial');
    if (await temporary.exists()) await temporary.delete();
    IOSink? sink;
    try {
      sink = temporary.openWrite();
      await _write(
        sink,
        title: title,
        segments: selectedSegments,
        format: format,
        selection: selection,
      );
      await _writeProbe?.call(sink);
      await sink.flush();
      await sink.close();
      sink = null;
      await temporary.rename(destination.path);
      return AudioExportReceipt(
        path: destination.path,
        format: format,
        bytes: await destination.length(),
      );
    } catch (_) {
      await _closeBestEffort(sink);
      if (await temporary.exists()) await temporary.delete();
      if (await destination.exists()) await destination.delete();
      rethrow;
    }
  }

  Future<void> _write(
    IOSink sink, {
    required String title,
    required List<TranscriptSegmentEntity> segments,
    required AudioExportFormat format,
    required AudioExportSelection selection,
  }) async {
    switch (format) {
      case AudioExportFormat.text:
        for (var index = 0; index < segments.length; index += 1) {
          final segment = segments[index];
          if (_startsParagraph(segments, index)) sink.writeln();
          sink.writeln(segment.text);
        }
      case AudioExportFormat.markdown:
        sink.writeln('# $title');
        sink.writeln();
        for (var index = 0; index < segments.length; index += 1) {
          final segment = segments[index];
          if (_startsParagraph(segments, index)) sink.writeln();
          sink.writeln(
            '- **${_clock(segment.startMs)}–${_clock(segment.endMs)}** '
            '${segment.text.replaceAll('\n', '  \n  ')}',
          );
        }
      case AudioExportFormat.json:
        sink.write(
          '{"title":${jsonEncode(title)},'
          '"selection":${jsonEncode(_selectionJson(selection))},'
          '"segments":[',
        );
        for (var index = 0; index < segments.length; index++) {
          final segment = segments[index];
          if (index > 0) sink.write(',');
          sink.write(
            jsonEncode(<String, Object?>{
              'sequenceId': segment.sequenceId,
              'startMs': segment.startMs,
              'endMs': segment.endMs,
              'text': segment.text,
              'confidence': segment.confidence,
              'reviewState': segment.reviewState.storageValue,
            }),
          );
        }
        sink.write(']}');
      case AudioExportFormat.srt:
        for (var index = 0; index < segments.length; index++) {
          final segment = segments[index];
          sink.writeln(index + 1);
          sink.writeln(
            '${_subtitleClock(segment.startMs, ',')} --> '
            '${_subtitleClock(segment.endMs, ',')}',
          );
          sink.writeln(segment.text);
          sink.writeln();
        }
      case AudioExportFormat.vtt:
        sink.writeln('WEBVTT');
        sink.writeln();
        for (var index = 0; index < segments.length; index += 1) {
          final segment = segments[index];
          sink.writeln(index + 1);
          sink.writeln(
            '${_subtitleClock(segment.startMs, '.')} --> '
            '${_subtitleClock(segment.endMs, '.')}',
          );
          sink.writeln(segment.text);
          sink.writeln();
        }
    }
  }

  String _clock(int milliseconds) {
    final duration = Duration(milliseconds: milliseconds);
    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60);
    final seconds = duration.inSeconds.remainder(60);
    return hours > 0
        ? '${hours.toString().padLeft(2, '0')}:'
              '${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}'
        : '${minutes.toString().padLeft(2, '0')}:'
              '${seconds.toString().padLeft(2, '0')}';
  }

  String _subtitleClock(int milliseconds, String millisecondSeparator) {
    final duration = Duration(milliseconds: milliseconds);
    return '${duration.inHours.toString().padLeft(2, '0')}:'
        '${duration.inMinutes.remainder(60).toString().padLeft(2, '0')}:'
        '${duration.inSeconds.remainder(60).toString().padLeft(2, '0')}'
        '$millisecondSeparator'
        '${duration.inMilliseconds.remainder(1000).toString().padLeft(3, '0')}';
  }

  bool _startsParagraph(List<TranscriptSegmentEntity> segments, int index) {
    return index > 0 &&
        segments[index].startMs - segments[index - 1].endMs >= 1500;
  }

  Map<String, Object?> _selectionJson(AudioExportSelection selection) {
    final range = selection.range;
    if (range == null) return const <String, Object?>{'type': 'all'};
    return <String, Object?>{
      'type': 'range',
      'startMs': range.startMs,
      'endMs': range.endMs,
    };
  }

  Future<void> _closeBestEffort(IOSink? sink) async {
    if (sink == null) return;
    try {
      await sink.close();
    } catch (_) {
      // Preserve the original export failure.
    }
  }
}
