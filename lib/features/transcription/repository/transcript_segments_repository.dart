import 'package:sqflite/sqflite.dart';

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
    final int now = DateTime.now().millisecondsSinceEpoch;
    final List<Map<String, Object?>> existing = await db.query(
      'transcript_segments',
      columns: <String>['id', 'created_at_ms'],
      where: 'recording_path = ? AND sequence_id = ?',
      whereArgs: <Object>[recordingPath, sequenceId],
      limit: 1,
    );

    final Map<String, Object?> values = <String, Object?>{
      'recording_path': recordingPath,
      'job_id': jobId,
      'sequence_id': sequenceId,
      'text': normalizedText,
      'start_ms': startMs,
      'end_ms': endMs,
      'is_final': isFinal ? 1 : 0,
      'source': source,
      'confidence': confidence,
      'created_at_ms': existing.isEmpty
          ? now
          : existing.first['created_at_ms'] as int,
      'updated_at_ms': now,
    };

    await db.insert(
      'transcript_segments',
      values,
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<TranscriptSegmentEntity>> listForRecordingPath(
    String recordingPath,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_segments',
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
      orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
    );
    return rows.map(TranscriptSegmentEntity.fromMap).toList();
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
