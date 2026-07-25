import '../../../data/sqlite/app_database.dart';
import '../model/transcript_generation_entity.dart';
import '../model/transcription_job_entity.dart';
import '../model/transcription_result.dart';

class TranscriptGenerationCommit {
  const TranscriptGenerationCommit({
    required this.generation,
    required this.activated,
    required this.replacementBlocked,
  });

  final TranscriptGenerationEntity generation;
  final bool activated;
  final bool replacementBlocked;
}

class TranscriptGenerationsRepository {
  TranscriptGenerationsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<TranscriptGenerationCommit> persistCompletedResult({
    required TranscriptionJobEntity job,
    required TranscriptionResult result,
  }) async {
    result.validate();
    final db = await _database.database;
    return db.transaction<TranscriptGenerationCommit>((transaction) async {
      final existing = await transaction.query(
        'transcript_generations',
        where: 'job_id = ?',
        whereArgs: <Object>[job.id],
        limit: 1,
      );
      if (existing.isNotEmpty) {
        final generation = TranscriptGenerationEntity.fromMap(existing.single);
        return TranscriptGenerationCommit(
          generation: generation,
          activated: generation.status == 'active',
          replacementBlocked: generation.status == 'conflict',
        );
      }

      final recordings = await transaction.query(
        'recordings',
        columns: <String>['id', 'active_generation_id'],
        where: job.recordingId == null ? 'file_path = ?' : 'id = ?',
        whereArgs: <Object>[job.recordingId ?? job.recordingPath],
        orderBy: 'id ASC',
        limit: 1,
      );
      final recordingId = recordings.isEmpty
          ? null
          : recordings.single['id'] as int;
      final activeGenerationId = recordings.isEmpty
          ? null
          : recordings.single['active_generation_id'] as int?;
      Map<String, Object?>? activeGeneration;
      if (activeGenerationId != null) {
        final rows = await transaction.query(
          'transcript_generations',
          where: 'id = ?',
          whereArgs: <Object>[activeGenerationId],
          limit: 1,
        );
        if (rows.isNotEmpty) activeGeneration = rows.single;
      }
      final replacementBlocked =
          activeGeneration != null &&
          ((activeGeneration['has_user_edits'] as int? ?? 0) == 1 ||
              (activeGeneration['has_evidence_links'] as int? ?? 0) == 1);
      final now = DateTime.now().millisecondsSinceEpoch;
      final generationId = await transaction
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': job.recordingPath,
            'job_id': job.id,
            'status': recordingId == null
                ? 'orphaned'
                : replacementBlocked
                ? 'conflict'
                : 'candidate',
            'source': job.source,
            'merged_text': result.mergedText,
            'has_user_edits': 0,
            'has_evidence_links': 0,
            'created_at_ms': now,
            'activated_at_ms': null,
            'updated_at_ms': now,
          });
      final batch = transaction.batch();
      for (final segment in result.segments) {
        batch.insert('transcript_segments', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': job.recordingPath,
          'generation_id': generationId,
          'job_id': job.id,
          'sequence_id': segment.sequenceId,
          'text': segment.text.trim(),
          'start_ms': segment.startMs,
          'end_ms': segment.endMs,
          'is_final': segment.isFinal ? 1 : 0,
          'source': segment.source,
          'confidence': segment.confidence,
          'created_at_ms': now,
          'updated_at_ms': now,
        });
      }
      await batch.commit(noResult: true);

      if (recordingId != null && !replacementBlocked) {
        if (activeGenerationId != null) {
          await transaction.update(
            'transcript_generations',
            <String, Object?>{'status': 'superseded', 'updated_at_ms': now},
            where: 'id = ?',
            whereArgs: <Object>[activeGenerationId],
          );
        }
        await transaction.update(
          'transcript_generations',
          <String, Object?>{
            'status': 'active',
            'activated_at_ms': now,
            'updated_at_ms': now,
          },
          where: 'id = ?',
          whereArgs: <Object>[generationId],
        );
        await transaction.update(
          'recordings',
          <String, Object?>{'active_generation_id': generationId},
          where: 'id = ?',
          whereArgs: <Object>[recordingId],
        );
      }

      final completed = await transaction.update(
        'transcription_jobs',
        <String, Object?>{
          'recording_id': recordingId,
          'generation_id': generationId,
          'status': 'completed',
          'stage': 'completed',
          'progress': 1.0,
          'result_text': result.mergedText,
          'error_message': replacementBlocked
              ? '新转写已保留为候选，现有已编辑或证据关联文本未被覆盖'
              : null,
          'error_code': replacementBlocked ? 'GENERATION_CONFLICT' : null,
          'failure_stage': null,
          'completed_at_ms': now,
          'heartbeat_at_ms': now,
          'updated_at_ms': now,
        },
        where: "id = ? AND status = 'processing' AND cancel_requested = 0",
        whereArgs: <Object>[job.id],
      );
      if (completed != 1) {
        throw StateError('转写任务状态已变化，结果未提交');
      }
      final rows = await transaction.query(
        'transcript_generations',
        where: 'id = ?',
        whereArgs: <Object>[generationId],
        limit: 1,
      );
      return TranscriptGenerationCommit(
        generation: TranscriptGenerationEntity.fromMap(rows.single),
        activated: recordingId != null && !replacementBlocked,
        replacementBlocked: replacementBlocked,
      );
    });
  }

  Future<TranscriptGenerationEntity?> findActiveForRecording(
    int recordingId,
  ) async {
    final db = await _database.database;
    final rows = await db.rawQuery(
      '''
      SELECT generation.*
      FROM recordings AS recording
      JOIN transcript_generations AS generation
        ON generation.id = recording.active_generation_id
      WHERE recording.id = ?
      LIMIT 1
      ''',
      <Object>[recordingId],
    );
    return rows.isEmpty
        ? null
        : TranscriptGenerationEntity.fromMap(rows.single);
  }

  Future<List<TranscriptGenerationEntity>> listForRecording(
    int recordingId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_generations',
      where: 'recording_id = ?',
      whereArgs: <Object>[recordingId],
      orderBy: 'id DESC',
    );
    return rows.map(TranscriptGenerationEntity.fromMap).toList(growable: false);
  }

  Future<void> markHasUserEdits(int generationId) {
    return _markProtected(generationId, column: 'has_user_edits');
  }

  Future<void> markHasEvidenceLinks(int generationId) {
    return _markProtected(generationId, column: 'has_evidence_links');
  }

  Future<void> _markProtected(
    int generationId, {
    required String column,
  }) async {
    final db = await _database.database;
    await db.update(
      'transcript_generations',
      <String, Object?>{
        column: 1,
        'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'id = ?',
      whereArgs: <Object>[generationId],
    );
  }
}
