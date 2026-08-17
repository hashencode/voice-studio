import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audios/model/audio_export_selection.dart';
import 'package:voice2text_flutter/features/audios/model/audio_time_range.dart';
import 'package:voice2text_flutter/features/audios/service/audio_export_service.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

import '../recording/recording_test_database.dart';

void main() {
  test('five formats have exact full and range-aware output', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final directory = await Directory.systemTemp.createTemp('audio-export-');
    addTearDown(() => directory.delete(recursive: true));
    final recordingId = await fixture.database
        .insert('recordings', <String, Object?>{
          'file_path': '/export.m4a',
          'display_name': '项目 周会',
          'duration_ms': 4000000,
          'created_at_ms': 1,
        });
    final service = AudioExportService(
      recordingsRepository: RecordingsRepository(database: fixture.appDatabase),
      exportDirectory: directory,
    );
    final segments = <TranscriptSegmentEntity>[
      _segment(7, '你好\n<world>', 0, 1234),
      _segment(9, 'gap1499', 2733, 4000),
      _segment(12, 'gap1500 🚀', 5500, 6501),
      _segment(20, 'over hour', 3600007, 3601234),
    ];

    final full = <AudioExportFormat, String>{};
    for (final format in AudioExportFormat.values) {
      final receipt = await service.export(
        recordingId: recordingId,
        title: '项目 周会',
        segments: segments,
        format: format,
        selection: const AudioExportSelection.all(),
      );
      expect(await File(receipt.path).exists(), isTrue);
      expect(receipt.bytes, greaterThan(0));
      full[format] = await File(receipt.path).readAsString();
    }

    expect(
      full[AudioExportFormat.text],
      '你好\n<world>\n'
      'gap1499\n'
      '\n'
      'gap1500 🚀\n'
      '\n'
      'over hour\n',
    );
    expect(
      full[AudioExportFormat.markdown],
      '# 项目 周会\n'
      '\n'
      '- **00:00–00:01** 你好  \n'
      '  <world>\n'
      '- **00:02–00:04** gap1499\n'
      '\n'
      '- **00:05–00:06** gap1500 🚀\n'
      '\n'
      '- **01:00:00–01:00:01** over hour\n',
    );
    expect(jsonDecode(full[AudioExportFormat.json]!), <String, Object?>{
      'title': '项目 周会',
      'selection': <String, Object?>{'type': 'all'},
      'segments': <Object?>[
        _jsonSegment(7, '你好\n<world>', 0, 1234),
        _jsonSegment(9, 'gap1499', 2733, 4000),
        _jsonSegment(12, 'gap1500 🚀', 5500, 6501),
        _jsonSegment(20, 'over hour', 3600007, 3601234),
      ],
    });
    expect(
      full[AudioExportFormat.srt],
      '1\n'
      '00:00:00,000 --> 00:00:01,234\n'
      '你好\n<world>\n'
      '\n'
      '2\n'
      '00:00:02,733 --> 00:00:04,000\n'
      'gap1499\n'
      '\n'
      '3\n'
      '00:00:05,500 --> 00:00:06,501\n'
      'gap1500 🚀\n'
      '\n'
      '4\n'
      '01:00:00,007 --> 01:00:01,234\n'
      'over hour\n'
      '\n',
    );
    final fullVtt = full[AudioExportFormat.vtt]!;
    expect(
      fullVtt,
      'WEBVTT\n'
      '\n'
      '1\n'
      '00:00:00.000 --> 00:00:01.234\n'
      '你好\n<world>\n'
      '\n'
      '2\n'
      '00:00:02.733 --> 00:00:04.000\n'
      'gap1499\n'
      '\n'
      '3\n'
      '00:00:05.500 --> 00:00:06.501\n'
      'gap1500 🚀\n'
      '\n'
      '4\n'
      '01:00:00.007 --> 01:00:01.234\n'
      'over hour\n'
      '\n',
    );
    _expectValidVtt(fullVtt, expectedCueCount: 4);

    final selection = AudioExportSelection.range(
      AudioTimeRange(startMs: 1000, endMs: 6000, durationMs: 4000000),
    );
    final ranged = <AudioExportFormat, String>{};
    for (final format in AudioExportFormat.values) {
      final receipt = await service.export(
        recordingId: recordingId,
        title: '项目 周会',
        segments: segments,
        format: format,
        selection: selection,
      );
      ranged[format] = await File(receipt.path).readAsString();
    }
    expect(ranged[AudioExportFormat.text], isNot(contains('over hour')));
    expect(ranged[AudioExportFormat.markdown], isNot(contains('over hour')));
    final rangedJson =
        jsonDecode(ranged[AudioExportFormat.json]!) as Map<String, Object?>;
    expect(rangedJson['selection'], <String, Object?>{
      'type': 'range',
      'startMs': 1000,
      'endMs': 6000,
    });
    expect(rangedJson['segments'], hasLength(3));
    expect(ranged[AudioExportFormat.srt], startsWith('1\n'));
    expect(ranged[AudioExportFormat.srt], contains('\n3\n'));
    expect(ranged[AudioExportFormat.srt], isNot(contains('\n4\n')));
    expect(
      ranged[AudioExportFormat.srt],
      contains('00:00:00,000 --> 00:00:01,234'),
    );
    _expectValidVtt(ranged[AudioExportFormat.vtt]!, expectedCueCount: 3);

    final assets = await fixture.database.query(
      'audio_assets',
      where: 'recording_id = ? AND kind = ?',
      whereArgs: <Object>[recordingId, 'transcript_export'],
    );
    expect(assets, hasLength(5));
  });

  test('empty range and sink failure leave no asset or partial file', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final directory = await Directory.systemTemp.createTemp('audio-fail-');
    addTearDown(() => directory.delete(recursive: true));
    final recordingId = await fixture.database.insert(
      'recordings',
      <String, Object?>{
        'file_path': '/fail.m4a',
        'duration_ms': 10000,
        'created_at_ms': 1,
      },
    );
    final repository = RecordingsRepository(database: fixture.appDatabase);
    final service = AudioExportService(
      recordingsRepository: repository,
      exportDirectory: directory,
    );
    final segments = <TranscriptSegmentEntity>[_segment(0, 'only', 0, 1000)];

    await expectLater(
      service.export(
        recordingId: recordingId,
        title: 'empty',
        segments: segments,
        format: AudioExportFormat.vtt,
        selection: AudioExportSelection.range(
          AudioTimeRange(startMs: 2000, endMs: 3000, durationMs: 10000),
        ),
      ),
      throwsStateError,
    );

    final failing = AudioExportService(
      recordingsRepository: repository,
      exportDirectory: directory,
      writeProbe: (_) async => throw StateError('simulated sink failure'),
    );
    await expectLater(
      failing.export(
        recordingId: recordingId,
        title: 'sink-failure',
        segments: segments,
        format: AudioExportFormat.vtt,
      ),
      throwsA(anything),
    );

    expect(
      await directory
          .list()
          .where((entity) => entity.path.endsWith('.partial'))
          .toList(),
      isEmpty,
    );
    expect(await fixture.database.query('audio_assets'), isEmpty);
  });

  test('large export writes a complete ordered file', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final directory = await Directory.systemTemp.createTemp('audio-large-');
    addTearDown(() => directory.delete(recursive: true));
    final recordingId = await fixture.database.insert(
      'recordings',
      <String, Object?>{
        'file_path': '/large.m4a',
        'duration_ms': 3000000,
        'created_at_ms': 1,
      },
    );
    final service = AudioExportService(
      recordingsRepository: RecordingsRepository(database: fixture.appDatabase),
      exportDirectory: directory,
    );
    final segments = List<TranscriptSegmentEntity>.generate(
      3000,
      (index) =>
          _segment(index, 'line $index', index * 1000, index * 1000 + 900),
    );
    final receipt = await service.export(
      recordingId: recordingId,
      title: 'large',
      segments: segments,
      format: AudioExportFormat.vtt,
    );
    final content = await File(receipt.path).readAsString();
    expect(content, startsWith('WEBVTT\n\n1\n'));
    expect(content, contains('\n3000\n'));
    expect(content, contains('line 2999'));
  });

  test('failed replacement restores the previous successful export', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final directory = await Directory.systemTemp.createTemp('audio-replace-');
    addTearDown(() => directory.delete(recursive: true));
    final recordingId = await fixture.database.insert(
      'recordings',
      <String, Object?>{
        'file_path': '/replace.m4a',
        'duration_ms': 10000,
        'created_at_ms': 1,
      },
    );
    final repository = RecordingsRepository(database: fixture.appDatabase);
    final successful = AudioExportService(
      recordingsRepository: repository,
      exportDirectory: directory,
    );
    final receipt = await successful.export(
      recordingId: recordingId,
      title: 'replace',
      segments: <TranscriptSegmentEntity>[
        _segment(0, 'previous content', 0, 1000),
      ],
      format: AudioExportFormat.vtt,
    );
    final previousContent = await File(receipt.path).readAsString();

    final failing = AudioExportService(
      recordingsRepository: _FailingAssetRepository(
        database: fixture.appDatabase,
      ),
      exportDirectory: directory,
    );
    await expectLater(
      failing.export(
        recordingId: recordingId,
        title: 'replace',
        segments: <TranscriptSegmentEntity>[
          _segment(0, 'replacement content', 0, 1000),
        ],
        format: AudioExportFormat.vtt,
      ),
      throwsStateError,
    );

    expect(await File(receipt.path).readAsString(), previousContent);
    expect(
      await directory
          .list()
          .where(
            (entity) =>
                entity.path.endsWith('.partial') ||
                entity.path.endsWith('.backup'),
          )
          .toList(),
      isEmpty,
    );
  });
}

class _FailingAssetRepository extends RecordingsRepository {
  _FailingAssetRepository({required super.database});

  @override
  Future<void> registerOwnedAsset({
    required int recordingId,
    required String path,
    required String kind,
  }) {
    throw StateError('simulated asset registration failure');
  }
}

Map<String, Object?> _jsonSegment(
  int sequenceId,
  String text,
  int startMs,
  int endMs,
) {
  return <String, Object?>{
    'sequenceId': sequenceId,
    'startMs': startMs,
    'endMs': endMs,
    'text': text,
    'confidence': 0.9,
    'reviewState': 'unreviewed',
  };
}

void _expectValidVtt(String content, {required int expectedCueCount}) {
  expect(utf8.encode(content).take(3), isNot(<int>[0xEF, 0xBB, 0xBF]));
  final blocks = content.trimRight().split('\n\n');
  expect(blocks.first, 'WEBVTT');
  final cues = blocks.skip(1).toList(growable: false);
  expect(cues, hasLength(expectedCueCount));
  for (var index = 0; index < cues.length; index += 1) {
    final lines = cues[index].split('\n');
    expect(lines.first, '${index + 1}');
    expect(
      lines[1],
      matches(
        RegExp(
          r'^\d{2,}:\d{2}:\d{2}\.\d{3} --> '
          r'\d{2,}:\d{2}:\d{2}\.\d{3}$',
        ),
      ),
    );
    expect(lines.length, greaterThanOrEqualTo(3));
  }
}

TranscriptSegmentEntity _segment(
  int sequence,
  String text,
  int start,
  int end,
) {
  return TranscriptSegmentEntity(
    id: sequence + 1,
    recordingPath: '/export.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: sequence,
    text: text,
    startMs: start,
    endMs: end,
    isFinal: true,
    source: 'test',
    confidence: 0.9,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}
