import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../engine/recorder_port.dart';
import '../model/recording_session_entity.dart';

class RecordingSessionsRepository {
  RecordingSessionsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<void> upsertSnapshot(RecordingSessionSnapshot snapshot) async {
    if (snapshot.sessionId.isEmpty) return;
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.insert('recording_sessions', <String, Object?>{
      'session_id': snapshot.sessionId,
      'state': snapshot.state,
      'staging_path': snapshot.stagingPath,
      'canonical_path': snapshot.canonicalPath,
      'duration_ms': snapshot.durationMs,
      'stop_reason': snapshot.stopReason,
      'error_category': snapshot.errorCategory,
      'native_created_at_ms': snapshot.createdAtMs,
      'native_updated_at_ms': snapshot.updatedAtMs,
      'created_at_ms': snapshot.createdAtMs ?? now,
      'updated_at_ms': now,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    await db.update(
      'recording_sessions',
      <String, Object?>{
        'state': snapshot.state,
        'staging_path': snapshot.stagingPath,
        'canonical_path': snapshot.canonicalPath,
        'duration_ms': snapshot.durationMs,
        'stop_reason': snapshot.stopReason,
        'error_category': snapshot.errorCategory,
        'native_created_at_ms': snapshot.createdAtMs,
        'native_updated_at_ms': snapshot.updatedAtMs,
        'updated_at_ms': now,
      },
      where: 'session_id = ?',
      whereArgs: <Object>[snapshot.sessionId],
    );
  }

  Future<int> commitCompleted(
    RecorderResult result, {
    bool enqueueTranscription = false,
  }) async {
    if (result.sessionId.isEmpty || result.path.isEmpty) {
      throw StateError('完成录音缺少 sessionId 或正式路径');
    }
    final db = await _database.database;
    return db.transaction<int>((transaction) async {
      final existing = await transaction.query(
        'recordings',
        columns: <String>['id'],
        where: 'session_id = ?',
        whereArgs: <Object>[result.sessionId],
        limit: 1,
      );
      final int recordingId;
      if (existing.isNotEmpty) {
        recordingId = existing.first['id'] as int;
      } else {
        recordingId = await transaction.insert('recordings', <String, Object?>{
          'file_path': result.path,
          'display_name': null,
          'group_name': null,
          'deleted_at_ms': null,
          'is_favorite': 0,
          'session_id': result.sessionId,
          'duration_ms': result.durationMs,
          'created_at_ms': DateTime.now().millisecondsSinceEpoch,
        });
      }
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('recording_sessions', <String, Object?>{
        'session_id': result.sessionId,
        'state': 'completed',
        'staging_path': null,
        'canonical_path': result.path,
        'duration_ms': result.durationMs,
        'stop_reason': result.stopReason,
        'error_category': null,
        'native_created_at_ms': null,
        'native_updated_at_ms': null,
        'recording_id': recordingId,
        'created_at_ms': now,
        'updated_at_ms': now,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      await transaction.update(
        'recording_sessions',
        <String, Object?>{
          'state': 'completed',
          'canonical_path': result.path,
          'duration_ms': result.durationMs,
          'stop_reason': result.stopReason,
          'error_category': null,
          'recording_id': recordingId,
          'updated_at_ms': now,
        },
        where: 'session_id = ?',
        whereArgs: <Object>[result.sessionId],
      );
      if (enqueueTranscription) {
        final existingJob = await transaction.query(
          'transcription_jobs',
          columns: <String>['id'],
          where: 'recording_path = ? AND source = ?',
          whereArgs: <Object>[result.path, 'standard_offline'],
          limit: 1,
        );
        if (existingJob.isEmpty) {
          final dedupeKey = '${result.path}|standard_offline';
          await transaction.insert('transcription_jobs', <String, Object?>{
            'recording_path': result.path,
            'duration_ms': result.durationMs,
            'status': 'pending',
            'recording_mode': 'standard',
            'source': 'standard_offline',
            'failure_stage': null,
            'stage': 'queued',
            'progress': 0.0,
            'attempt_count': 0,
            'cancel_requested': 0,
            'error_code': null,
            'dedupe_key': dedupeKey,
            'started_at_ms': null,
            'completed_at_ms': null,
            'heartbeat_at_ms': null,
            'recording_id': recordingId,
            'generation_id': null,
            'created_at_ms': now,
            'updated_at_ms': now,
            'result_text': null,
            'error_message': null,
          });
        }
      }
      return recordingId;
    });
  }

  Future<List<RecordingSessionEntity>> listPendingRecovery() async {
    final db = await _database.database;
    final rows = await db.query(
      'recording_sessions',
      where: "state IN ('recoverable', 'invalid')",
      orderBy: 'created_at_ms ASC',
    );
    return rows.map(RecordingSessionEntity.fromMap).toList(growable: false);
  }

  Future<void> markDiscarded(String sessionId) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      await transaction.delete(
        'recording_annotations',
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
      );
      await transaction.update(
        'recording_sessions',
        <String, Object?>{
          'state': 'discarded',
          'staging_path': null,
          'error_category': null,
          'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
        },
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
      );
    });
  }

  Future<RecordingSessionEntity?> findBySessionId(String sessionId) async {
    final db = await _database.database;
    final rows = await db.query(
      'recording_sessions',
      where: 'session_id = ?',
      whereArgs: <Object>[sessionId],
      limit: 1,
    );
    return rows.isEmpty ? null : RecordingSessionEntity.fromMap(rows.first);
  }
}
