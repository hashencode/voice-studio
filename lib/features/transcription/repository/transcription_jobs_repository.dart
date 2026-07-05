import '../../../data/sqlite/app_database.dart';
import '../model/transcription_job_entity.dart';

class TranscriptionJobsRepository {
  TranscriptionJobsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<int> insertPendingJob({
    required String recordingPath,
    required int durationMs,
    String recordingMode = 'standard',
    String source = 'standard_offline',
    String? failureStage,
    double? progress,
  }) async {
    final db = await _database.database;
    final int now = DateTime.now().millisecondsSinceEpoch;

    return db.insert('transcription_jobs', {
      'recording_path': recordingPath,
      'duration_ms': durationMs,
      'status': 'pending',
      'recording_mode': recordingMode,
      'source': source,
      'failure_stage': failureStage,
      'progress': progress,
      'created_at_ms': now,
      'updated_at_ms': now,
      'result_text': null,
      'error_message': null,
    });
  }

  Future<List<TranscriptionJobEntity>> listRecent() async {
    final db = await _database.database;
    final rows = await db.query(
      'transcription_jobs',
      orderBy: 'id DESC',
      limit: 200,
    );
    return rows.map(TranscriptionJobEntity.fromMap).toList();
  }

  Future<TranscriptionJobEntity?> findById(int id) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcription_jobs',
      where: 'id = ?',
      whereArgs: <Object>[id],
      limit: 1,
    );

    if (rows.isEmpty) return null;
    return TranscriptionJobEntity.fromMap(rows.first);
  }

  Future<TranscriptionJobEntity?> findLatestByRecordingPath(
    String recordingPath,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcription_jobs',
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
      orderBy: 'updated_at_ms DESC, id DESC',
      limit: 1,
    );

    if (rows.isEmpty) return null;
    return TranscriptionJobEntity.fromMap(rows.first);
  }

  Future<void> deleteByRecordingPath(String recordingPath) async {
    final db = await _database.database;
    await db.delete(
      'transcription_jobs',
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
    );
  }

  Future<void> updateStatus({
    required int id,
    required String status,
    String? resultText,
    String? errorMessage,
    String? recordingMode,
    String? source,
    String? failureStage,
    double? progress,
  }) async {
    final db = await _database.database;
    final Map<String, Object?> values = <String, Object?>{
      'status': status,
      'result_text': resultText,
      'error_message': errorMessage,
      'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
    };
    if (recordingMode != null) {
      values['recording_mode'] = recordingMode;
    }
    if (source != null) {
      values['source'] = source;
    }
    if (failureStage != null) {
      values['failure_stage'] = failureStage;
    }
    if (progress != null) {
      values['progress'] = progress;
    }

    await db.update(
      'transcription_jobs',
      values,
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }
}
