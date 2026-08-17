import '../../../data/sqlite/app_database.dart';
import '../model/transcript_segment_entity.dart';

class TranscriptSegmentsRepository {
  TranscriptSegmentsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<void> upsertSegment({
    required String recordingPath,
    required int sequenceId,
    required String text,
    required int startMs,
    required int endMs,
    int? jobId,
    bool isFinal = true,
    String source = 'realtime',
    double? confidence,
  }) async {
    final String normalizedText = text.trim();
    if (recordingPath.trim().isEmpty || normalizedText.isEmpty) {
      return;
    }

    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final recordings = await transaction.query(
        'recordings',
        columns: <String>['id', 'active_generation_id'],
        where: 'file_path = ?',
        whereArgs: <Object>[recordingPath],
        orderBy: 'id ASC',
        limit: 1,
      );
      if (recordings.isEmpty) return;
      final recordingId = recordings.single['id'] as int;
      var generationId = recordings.single['active_generation_id'] as int?;
      final int now = DateTime.now().millisecondsSinceEpoch;
      if (generationId == null) {
        generationId = await transaction
            .insert('transcript_generations', <String, Object?>{
              'recording_id': recordingId,
              'recording_path': recordingPath,
              'job_id': jobId,
              'status': 'active',
              'source': source,
              'merged_text': normalizedText,
              'has_user_edits': 0,
              'has_evidence_links': 0,
              'created_at_ms': now,
              'activated_at_ms': now,
              'updated_at_ms': now,
            });
        await transaction.update(
          'recordings',
          <String, Object?>{'active_generation_id': generationId},
          where: 'id = ?',
          whereArgs: <Object>[recordingId],
        );
      }
      final existing = await transaction.query(
        'transcript_segments',
        columns: <String>['id', 'created_at_ms'],
        where: 'generation_id = ? AND sequence_id = ?',
        whereArgs: <Object>[generationId, sequenceId],
        limit: 1,
      );
      final values = <String, Object?>{
        'recording_id': recordingId,
        'recording_path': recordingPath,
        'generation_id': generationId,
        'job_id': jobId,
        'sequence_id': sequenceId,
        'text': normalizedText,
        'start_ms': startMs,
        'end_ms': endMs,
        'is_final': isFinal ? 1 : 0,
        'source': source,
        'confidence': confidence,
        'updated_at_ms': now,
      };
      if (existing.isEmpty) {
        await transaction.insert('transcript_segments', <String, Object?>{
          ...values,
          'created_at_ms': now,
        });
      } else {
        await transaction.update(
          'transcript_segments',
          values,
          where: 'id = ?',
          whereArgs: <Object>[existing.single['id'] as int],
        );
      }
      final rows = await transaction.query(
        'transcript_segments',
        columns: <String>['text'],
        where: 'generation_id = ?',
        whereArgs: <Object>[generationId],
        orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
      );
      await transaction.update(
        'transcript_generations',
        <String, Object?>{
          'merged_text': rows
              .map((row) => (row['text'] as String).trim())
              .where((value) => value.isNotEmpty)
              .join(' '),
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[generationId],
      );
    });
  }

  Future<List<TranscriptSegmentEntity>> listForRecordingPath(
    String recordingPath,
  ) async {
    final db = await _database.database;
    final rows = await db.rawQuery(
      '''
      SELECT segment.*
      FROM recordings AS recording
      JOIN transcript_segments AS segment
        ON segment.generation_id = recording.active_generation_id
      WHERE recording.file_path = ?
      ORDER BY segment.sequence_id ASC, segment.start_ms ASC, segment.id ASC
      ''',
      <Object>[recordingPath],
    );
    return rows.map(TranscriptSegmentEntity.fromMap).toList();
  }

  Future<List<TranscriptSegmentEntity>> listForGeneration(
    int generationId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_segments',
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
    );
    return rows.map(TranscriptSegmentEntity.fromMap).toList(growable: false);
  }

  Future<List<TranscriptSegmentEntity>> listRecent({int limit = 100}) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_segments',
      orderBy: 'updated_at_ms DESC, id DESC',
      limit: limit,
    );
    return rows.map(TranscriptSegmentEntity.fromMap).toList();
  }

  Future<bool> markNeedsReview(int segmentId, {int? generationId}) {
    return updateReviewState(
      segmentId: segmentId,
      generationId: generationId,
      state: TranscriptReviewState.needsReview,
    );
  }

  Future<bool> markReviewed(int segmentId, {int? generationId}) {
    return updateReviewState(
      segmentId: segmentId,
      generationId: generationId,
      state: TranscriptReviewState.reviewed,
    );
  }

  Future<bool> markUnreviewed(int segmentId, {int? generationId}) {
    return updateReviewState(
      segmentId: segmentId,
      generationId: generationId,
      state: TranscriptReviewState.unreviewed,
    );
  }

  Future<bool> updateReviewState({
    required int segmentId,
    int? generationId,
    required TranscriptReviewState state,
  }) async {
    final db = await _database.database;
    return db.transaction<bool>((transaction) async {
      final where = generationId == null
          ? 'id = ?'
          : 'id = ? AND generation_id = ?';
      final whereArgs = <Object>[segmentId, ?generationId];
      final rows = await transaction.query(
        'transcript_segments',
        columns: <String>['id'],
        where: where,
        whereArgs: whereArgs,
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final now = DateTime.now().millisecondsSinceEpoch;
      final updated = await transaction.update(
        'transcript_segments',
        <String, Object?>{
          'review_state': state.storageValue,
          'reviewed_at_ms': state == TranscriptReviewState.reviewed
              ? now
              : null,
          'updated_at_ms': now,
        },
        where: where,
        whereArgs: whereArgs,
      );
      return updated == 1;
    });
  }

  Future<String> mergedTextForRecordingPath(String recordingPath) async {
    final List<TranscriptSegmentEntity> segments = await listForRecordingPath(
      recordingPath,
    );
    return segments
        .where(
          (TranscriptSegmentEntity segment) => segment.text.trim().isNotEmpty,
        )
        .map((TranscriptSegmentEntity segment) => segment.text.trim())
        .join('\n');
  }

  Future<void> attachJobId({
    required String recordingPath,
    required int jobId,
  }) async {
    final db = await _database.database;
    await db.update(
      'transcript_segments',
      <String, Object?>{'job_id': jobId},
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
    );
  }

  Future<void> deleteByRecordingPath(String recordingPath) async {
    final db = await _database.database;
    await db.delete(
      'transcript_segments',
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
    );
  }
}
