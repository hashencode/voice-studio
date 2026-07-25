import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

import '../recording/recording_test_database.dart';

Future<
  ({
    Database database,
    AppDatabase appDatabase,
    int recordingId,
    int generationId,
    TranscriptSegmentEntity segment,
    MeetingIntelligenceRequest request,
  })
>
createMeetingIntelligenceFixture() async {
  final fixture = await openRecordingTestDatabase();
  final recordingId = await fixture.database.insert(
    'recordings',
    <String, Object?>{
      'file_path': '/intelligence.m4a',
      'duration_ms': 10000,
      'created_at_ms': 1,
    },
  );
  final generationId = await fixture.database
      .insert('transcript_generations', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': '/intelligence.m4a',
        'status': 'active',
        'source': 'test',
        'merged_text': 'We decided to ship.',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
  final segmentId = await fixture.database
      .insert('transcript_segments', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': '/intelligence.m4a',
        'generation_id': generationId,
        'sequence_id': 0,
        'text': 'We decided to ship.',
        'start_ms': 1000,
        'end_ms': 4000,
        'source': 'test',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
  await fixture.database.update(
    'recordings',
    <String, Object?>{'active_generation_id': generationId},
    where: 'id = ?',
    whereArgs: <Object>[recordingId],
  );
  final segment = TranscriptSegmentEntity(
    id: segmentId,
    recordingPath: '/intelligence.m4a',
    recordingId: recordingId,
    generationId: generationId,
    jobId: null,
    sequenceId: 0,
    text: 'We decided to ship.',
    startMs: 1000,
    endMs: 4000,
    isFinal: true,
    source: 'test',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
  return (
    database: fixture.database,
    appDatabase: fixture.appDatabase,
    recordingId: recordingId,
    generationId: generationId,
    segment: segment,
    request: MeetingIntelligenceRequest(
      recordingId: recordingId,
      generationId: generationId,
      processingLocation: MeetingProcessingLocation.local,
      consentDecision: MeetingConsentDecision.granted,
      inputStartMs: 0,
      inputEndMs: 10000,
      segments: <TranscriptSegmentEntity>[segment],
    ),
  );
}
