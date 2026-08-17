import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/transcript_revision_entity.dart';

class TranscriptRevisionsRepository {
  TranscriptRevisionsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<TranscriptRevisionEntity?> saveEdit({
    required int segmentId,
    required String text,
    bool markReviewed = false,
  }) async {
    final normalized = text.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(text, 'text', '转写文本不能为空');
    }
    final db = await _database.database;
    return db.transaction<TranscriptRevisionEntity?>((transaction) async {
      final rows = await transaction.query(
        'transcript_segments',
        where: 'id = ?',
        whereArgs: <Object>[segmentId],
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final segment = rows.single;
      final previous = segment['text'] as String;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (previous == normalized) {
        if (markReviewed) {
          await transaction.update(
            'transcript_segments',
            <String, Object?>{
              'review_state': 'reviewed',
              'reviewed_at_ms': now,
              'updated_at_ms': now,
            },
            where: 'id = ?',
            whereArgs: <Object>[segmentId],
          );
        }
        return null;
      }
      final recordingId = segment['recording_id'] as int?;
      if (recordingId == null) {
        throw StateError('孤立转写片段不可编辑');
      }
      final generationId = segment['generation_id'] as int;
      await transaction.update(
        'transcript_revisions',
        <String, Object?>{'invalidated_at_ms': now},
        where:
            'generation_id = ? '
            'AND reverted_at_ms IS NOT NULL '
            'AND invalidated_at_ms IS NULL',
        whereArgs: <Object>[generationId],
      );
      final id = await transaction
          .insert('transcript_revisions', <String, Object?>{
            'recording_id': recordingId,
            'generation_id': generationId,
            'segment_id': segmentId,
            'previous_text': previous,
            'next_text': normalized,
            'created_at_ms': now,
            'reverted_at_ms': null,
            'invalidated_at_ms': null,
          });
      await transaction.update(
        'transcript_segments',
        <String, Object?>{
          'text': normalized,
          'updated_at_ms': now,
          if (markReviewed) ...<String, Object?>{
            'review_state': 'reviewed',
            'reviewed_at_ms': now,
          },
        },
        where: 'id = ?',
        whereArgs: <Object>[segmentId],
      );
      await _refreshGeneration(transaction, generationId, now);
      final revision = await transaction.query(
        'transcript_revisions',
        where: 'id = ?',
        whereArgs: <Object>[id],
        limit: 1,
      );
      return TranscriptRevisionEntity.fromMap(revision.single);
    });
  }

  Future<TranscriptRevisionEntity?> undoLastForGeneration(
    int generationId,
  ) async {
    final db = await _database.database;
    return db.transaction<TranscriptRevisionEntity?>((transaction) async {
      final rows = await transaction.query(
        'transcript_revisions',
        where:
            'generation_id = ? '
            'AND reverted_at_ms IS NULL '
            'AND invalidated_at_ms IS NULL',
        whereArgs: <Object>[generationId],
        orderBy: 'id DESC',
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final revision = TranscriptRevisionEntity.fromMap(rows.single);
      final now = await _nextRevertTimestamp(transaction, generationId);
      await transaction.update(
        'transcript_segments',
        <String, Object?>{'text': revision.previousText, 'updated_at_ms': now},
        where: 'id = ?',
        whereArgs: <Object>[revision.segmentId],
      );
      await transaction.update(
        'transcript_revisions',
        <String, Object?>{'reverted_at_ms': now},
        where: 'id = ?',
        whereArgs: <Object>[revision.id],
      );
      await _refreshGeneration(transaction, generationId, now);
      return TranscriptRevisionEntity(
        id: revision.id,
        recordingId: revision.recordingId,
        generationId: revision.generationId,
        segmentId: revision.segmentId,
        previousText: revision.previousText,
        nextText: revision.nextText,
        createdAtMs: revision.createdAtMs,
        revertedAtMs: now,
        invalidatedAtMs: revision.invalidatedAtMs,
      );
    });
  }

  Future<TranscriptRevisionEntity?> redoLastForGeneration(
    int generationId,
  ) async {
    final db = await _database.database;
    return db.transaction<TranscriptRevisionEntity?>((transaction) async {
      final rows = await transaction.query(
        'transcript_revisions',
        where:
            'generation_id = ? '
            'AND reverted_at_ms IS NOT NULL '
            'AND invalidated_at_ms IS NULL',
        whereArgs: <Object>[generationId],
        orderBy: 'reverted_at_ms DESC, id DESC',
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final revision = TranscriptRevisionEntity.fromMap(rows.single);
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.update(
        'transcript_segments',
        <String, Object?>{'text': revision.nextText, 'updated_at_ms': now},
        where: 'id = ? AND generation_id = ?',
        whereArgs: <Object>[revision.segmentId, generationId],
      );
      await transaction.update(
        'transcript_revisions',
        <String, Object?>{'reverted_at_ms': null},
        where: 'id = ?',
        whereArgs: <Object>[revision.id],
      );
      await _refreshGeneration(transaction, generationId, now);
      return TranscriptRevisionEntity(
        id: revision.id,
        recordingId: revision.recordingId,
        generationId: revision.generationId,
        segmentId: revision.segmentId,
        previousText: revision.previousText,
        nextText: revision.nextText,
        createdAtMs: revision.createdAtMs,
        revertedAtMs: null,
        invalidatedAtMs: revision.invalidatedAtMs,
      );
    });
  }

  Future<bool> canUndo(int generationId) {
    return _hasCandidate(
      generationId,
      where:
          'generation_id = ? '
          'AND reverted_at_ms IS NULL '
          'AND invalidated_at_ms IS NULL',
    );
  }

  Future<bool> canRedo(int generationId) {
    return _hasCandidate(
      generationId,
      where:
          'generation_id = ? '
          'AND reverted_at_ms IS NOT NULL '
          'AND invalidated_at_ms IS NULL',
    );
  }

  Future<List<TranscriptRevisionEntity>> listForSegment(int segmentId) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_revisions',
      where: 'segment_id = ?',
      whereArgs: <Object>[segmentId],
      orderBy: 'created_at_ms DESC, id DESC',
    );
    return rows.map(TranscriptRevisionEntity.fromMap).toList(growable: false);
  }

  Future<void> _refreshGeneration(
    DatabaseExecutor transaction,
    int generationId,
    int now,
  ) async {
    final segments = await transaction.query(
      'transcript_segments',
      columns: <String>['text'],
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
    );
    await transaction.update(
      'transcript_generations',
      <String, Object?>{
        'merged_text': segments
            .map((row) => (row['text'] as String).trim())
            .where((value) => value.isNotEmpty)
            .join(' '),
        'has_user_edits': 1,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[generationId],
    );
  }

  Future<int> _nextRevertTimestamp(
    DatabaseExecutor transaction,
    int generationId,
  ) async {
    final rows = await transaction.rawQuery(
      'SELECT MAX(reverted_at_ms) AS latest_reverted_at_ms '
      'FROM transcript_revisions '
      'WHERE generation_id = ?',
      <Object>[generationId],
    );
    final latest = rows.single['latest_reverted_at_ms'] as int?;
    final clock = DateTime.now().millisecondsSinceEpoch;
    if (latest == null || clock > latest) return clock;
    return latest + 1;
  }

  Future<bool> _hasCandidate(int generationId, {required String where}) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_revisions',
      columns: <String>['id'],
      where: where,
      whereArgs: <Object>[generationId],
      limit: 1,
    );
    return rows.isNotEmpty;
  }
}
