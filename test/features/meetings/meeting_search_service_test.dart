import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:voice2text_flutter/features/meetings/model/meeting_time_range.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_search_service.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'combines text, time, and manual state on the active generation',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final seeded = await _seedSearchFixture(fixture.database);
      final service = MeetingSearchService(database: fixture.appDatabase);

      expect(
        await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(),
        ),
        isEmpty,
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(text: 'ALPHA'),
        )).map((item) => item.text),
        const <String>['Alpha 你好 100%', 'ALPHA combo'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(text: '你好'),
        )).map((item) => item.text),
        const <String>['Alpha 你好 100%'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(text: '%'),
        )).map((item) => item.text),
        const <String>['Alpha 你好 100%'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(text: '_'),
        )).map((item) => item.text),
        const <String>['Beta_under'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: MeetingTranscriptQuery(
            timeRange: MeetingTimeRange(
              startMs: 1000,
              endMs: 2500,
              durationMs: 10000,
            ),
          ),
        )).map((item) => item.text),
        const <String>['Beta_under'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(
            reviewState: TranscriptReviewState.needsReview,
          ),
        )).map((item) => item.text),
        const <String>['Beta_under', 'ALPHA combo'],
      );
      expect(
        (await service.search(
          recordingId: seeded.recordingId,
          query: MeetingTranscriptQuery(
            text: 'alpha',
            timeRange: MeetingTimeRange(
              startMs: 3500,
              endMs: 4500,
              durationMs: 10000,
            ),
            reviewState: TranscriptReviewState.needsReview,
          ),
        )).map((item) => item.text),
        const <String>['ALPHA combo'],
      );
      expect(
        await service.search(
          recordingId: seeded.recordingId,
          query: const MeetingTranscriptQuery(text: 'missing'),
        ),
        isEmpty,
      );
      expect(
        await service.search(
          recordingId: seeded.otherRecordingId,
          query: const MeetingTranscriptQuery(text: 'ghost'),
        ),
        isEmpty,
      );
    },
  );

  test(
    'returns 3000 matching segments in stable order when requested',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final db = fixture.database;
      final recordingId = await db.insert('recordings', <String, Object?>{
        'file_path': '/large-search.m4a',
        'duration_ms': 3000000,
        'created_at_ms': 1,
      });
      final generationId = await db
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': '/large-search.m4a',
            'status': 'active',
            'source': 'test',
            'merged_text': '',
            'created_at_ms': 1,
            'updated_at_ms': 1,
          });
      await db.update(
        'recordings',
        <String, Object?>{'active_generation_id': generationId},
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
      final batch = db.batch();
      for (var index = 0; index < 3000; index += 1) {
        batch.insert('transcript_segments', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': '/large-search.m4a',
          'generation_id': generationId,
          'sequence_id': index,
          'text': 'target $index',
          'start_ms': index * 1000,
          'end_ms': index * 1000 + 800,
          'source': 'test',
          'review_state': 'needs_review',
          'created_at_ms': 1,
          'updated_at_ms': 1,
        });
      }
      await batch.commit(noResult: true);
      final service = MeetingSearchService(database: fixture.appDatabase);

      final results = await service.search(
        recordingId: recordingId,
        query: const MeetingTranscriptQuery(
          reviewState: TranscriptReviewState.needsReview,
        ),
        limit: 3000,
      );

      expect(results, hasLength(3000));
      expect(results.first.sequenceId, 0);
      expect(results.last.sequenceId, 2999);
    },
  );
}

Future<({int recordingId, int otherRecordingId})> _seedSearchFixture(
  Database db,
) async {
  final recordingId = await db.insert('recordings', <String, Object?>{
    'file_path': '/one.m4a',
    'duration_ms': 10000,
    'created_at_ms': 1,
  });
  final otherRecordingId = await db.insert('recordings', <String, Object?>{
    'file_path': '/two.m4a',
    'duration_ms': 10000,
    'created_at_ms': 1,
  });
  final generationId = await db
      .insert('transcript_generations', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': '/one.m4a',
        'status': 'active',
        'source': 'test',
        'merged_text': '',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
  final inactiveGenerationId = await db
      .insert('transcript_generations', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': '/one.m4a',
        'status': 'superseded',
        'source': 'test',
        'merged_text': 'Alpha ghost',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
  await db.update(
    'recordings',
    <String, Object?>{'active_generation_id': generationId},
    where: 'id = ?',
    whereArgs: <Object>[recordingId],
  );
  for (final entry
      in <({String text, int sequence, int start, int end, String state})>[
        (
          text: 'Alpha 你好 100%',
          sequence: 0,
          start: 0,
          end: 1000,
          state: 'unreviewed',
        ),
        (
          text: 'Beta_under',
          sequence: 1,
          start: 1000,
          end: 2000,
          state: 'needs_review',
        ),
        (text: 'Gamma', sequence: 2, start: 2500, end: 3500, state: 'reviewed'),
        (
          text: 'ALPHA combo',
          sequence: 3,
          start: 4000,
          end: 5000,
          state: 'needs_review',
        ),
      ]) {
    await db.insert('transcript_segments', <String, Object?>{
      'recording_id': recordingId,
      'recording_path': '/one.m4a',
      'generation_id': generationId,
      'sequence_id': entry.sequence,
      'text': entry.text,
      'start_ms': entry.start,
      'end_ms': entry.end,
      'source': 'test',
      'review_state': entry.state,
      'created_at_ms': 1,
      'updated_at_ms': 1,
    });
  }
  await db.insert('transcript_segments', <String, Object?>{
    'recording_id': recordingId,
    'recording_path': '/one.m4a',
    'generation_id': inactiveGenerationId,
    'sequence_id': 0,
    'text': 'Alpha ghost',
    'start_ms': 0,
    'end_ms': 900,
    'source': 'test',
    'created_at_ms': 1,
    'updated_at_ms': 1,
  });
  return (recordingId: recordingId, otherRecordingId: otherRecordingId);
}
