import '../../../data/sqlite/app_database.dart';
import '../model/transcription_job_entity.dart';

class TranscriptionEnqueueResult {
  const TranscriptionEnqueueResult({
    required this.jobId,
    required this.inserted,
  });

  final int jobId;
  final bool inserted;
}

class TranscriptionCancellationResult {
  const TranscriptionCancellationResult({
    required this.accepted,
    required this.wasProcessing,
  });

  final bool accepted;
  final bool wasProcessing;
}

enum TranscriptionRecordingRetryStatus { retried, jobNotFound, jobNotRetryable }

class TranscriptionRecordingRetryResult {
  const TranscriptionRecordingRetryResult({
    required this.recordingId,
    required this.status,
    this.jobId,
  });

  final int recordingId;
  final TranscriptionRecordingRetryStatus status;
  final int? jobId;
}

class TranscriptionJobsRepository {
  TranscriptionJobsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;
  AppDatabase get database => _database;

  Future<TranscriptionEnqueueResult> enqueue({
    required String recordingPath,
    required int durationMs,
    String recordingMode = 'standard',
    String source = 'standard_offline',
  }) async {
    final db = await _database.database;
    final dedupeKey = _dedupeKey(recordingPath, source);
    return db.transaction<TranscriptionEnqueueResult>((transaction) async {
      final active = await transaction.query(
        'transcription_jobs',
        columns: <String>['id'],
        where: "dedupe_key = ? AND status IN ('pending', 'processing')",
        whereArgs: <Object>[dedupeKey],
        orderBy: 'id ASC',
        limit: 1,
      );
      if (active.isNotEmpty) {
        return TranscriptionEnqueueResult(
          jobId: active.single['id'] as int,
          inserted: false,
        );
      }
      final recordings = await transaction.query(
        'recordings',
        columns: <String>['id'],
        where: 'file_path = ?',
        whereArgs: <Object>[recordingPath],
        orderBy: 'id ASC',
        limit: 1,
      );
      final now = DateTime.now().millisecondsSinceEpoch;
      final id = await transaction
          .insert('transcription_jobs', <String, Object?>{
            'recording_path': recordingPath,
            'duration_ms': durationMs,
            'status': 'pending',
            'recording_mode': recordingMode,
            'source': source,
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
            'recording_id': recordings.isEmpty
                ? null
                : recordings.single['id'] as int,
            'generation_id': null,
            'created_at_ms': now,
            'updated_at_ms': now,
            'result_text': null,
            'error_message': null,
          });
      return TranscriptionEnqueueResult(jobId: id, inserted: true);
    });
  }

  Future<int> insertPendingJob({
    required String recordingPath,
    required int durationMs,
    String recordingMode = 'standard',
    String source = 'standard_offline',
    String? failureStage,
    double? progress,
  }) async {
    final result = await enqueue(
      recordingPath: recordingPath,
      durationMs: durationMs,
      recordingMode: recordingMode,
      source: source,
    );
    return result.jobId;
  }

  Future<TranscriptionJobEntity?> claimNextPending() async {
    final db = await _database.database;
    return db.transaction<TranscriptionJobEntity?>((transaction) async {
      final rows = await transaction.query(
        'transcription_jobs',
        where: "status = 'pending' AND cancel_requested = 0",
        orderBy: 'created_at_ms ASC, id ASC',
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final row = rows.single;
      final id = row['id'] as int;
      final now = DateTime.now().millisecondsSinceEpoch;
      final updated = await transaction.update(
        'transcription_jobs',
        <String, Object?>{
          'status': 'processing',
          'stage': 'queued',
          'attempt_count': (row['attempt_count'] as int? ?? 0) + 1,
          'started_at_ms': now,
          'heartbeat_at_ms': now,
          'updated_at_ms': now,
          'completed_at_ms': null,
          'failure_stage': null,
          'error_code': null,
          'error_message': null,
          'result_text': null,
        },
        where: "id = ? AND status = 'pending' AND cancel_requested = 0",
        whereArgs: <Object>[id],
      );
      if (updated != 1) return null;
      final claimed = await transaction.query(
        'transcription_jobs',
        where: 'id = ?',
        whereArgs: <Object>[id],
        limit: 1,
      );
      return TranscriptionJobEntity.fromMap(claimed.single);
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

  Future<List<TranscriptionJobEntity>> listProcessing({
    Set<int>? jobIds,
  }) async {
    if (jobIds != null && jobIds.isEmpty) {
      return const <TranscriptionJobEntity>[];
    }
    final db = await _database.database;
    final placeholders = jobIds == null
        ? null
        : List<String>.filled(jobIds.length, '?').join(', ');
    final rows = await db.query(
      'transcription_jobs',
      where: placeholders == null
          ? "status = 'processing'"
          : "status = 'processing' AND id IN ($placeholders)",
      whereArgs: jobIds?.cast<Object>().toList(),
      orderBy: 'started_at_ms ASC, id ASC',
    );
    return rows.map(TranscriptionJobEntity.fromMap).toList(growable: false);
  }

  Future<TranscriptionJobEntity?> findById(int id) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcription_jobs',
      where: 'id = ?',
      whereArgs: <Object>[id],
      limit: 1,
    );
    return rows.isEmpty ? null : TranscriptionJobEntity.fromMap(rows.single);
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
    return rows.isEmpty ? null : TranscriptionJobEntity.fromMap(rows.single);
  }

  Future<Map<String, TranscriptionJobEntity>> findLatestByRecordingPaths(
    Iterable<String> recordingPaths,
  ) async {
    final paths = recordingPaths.toSet().toList(growable: false);
    if (paths.isEmpty) return const <String, TranscriptionJobEntity>{};
    final db = await _database.database;
    final latestByPath = <String, TranscriptionJobEntity>{};
    for (var offset = 0; offset < paths.length; offset += 500) {
      final end = offset + 500 < paths.length ? offset + 500 : paths.length;
      final batch = paths.sublist(offset, end);
      final placeholders = List<String>.filled(batch.length, '?').join(', ');
      final rows = await db.query(
        'transcription_jobs',
        where: 'recording_path IN ($placeholders)',
        whereArgs: batch,
        orderBy: 'updated_at_ms DESC, id DESC',
      );
      for (final row in rows) {
        final job = TranscriptionJobEntity.fromMap(row);
        latestByPath.putIfAbsent(job.recordingPath, () => job);
      }
    }
    return latestByPath;
  }

  Future<Map<int, TranscriptionJobEntity>> findLatestByRecordingIds(
    Iterable<int> recordingIds,
  ) async {
    final ids = recordingIds.toSet().toList(growable: false);
    if (ids.isEmpty) return const <int, TranscriptionJobEntity>{};
    final db = await _database.database;
    final latestByRecordingId = <int, TranscriptionJobEntity>{};
    for (var offset = 0; offset < ids.length; offset += 500) {
      final end = offset + 500 < ids.length ? offset + 500 : ids.length;
      final batch = ids.sublist(offset, end);
      final placeholders = List<String>.filled(batch.length, '?').join(', ');
      final rows = await db.query(
        'transcription_jobs',
        where: 'recording_id IN ($placeholders)',
        whereArgs: batch.cast<Object>(),
        orderBy: 'updated_at_ms DESC, id DESC',
      );
      for (final row in rows) {
        final job = TranscriptionJobEntity.fromMap(row);
        final recordingId = row['recording_id'] as int?;
        if (recordingId != null) {
          latestByRecordingId.putIfAbsent(recordingId, () => job);
        }
      }
    }
    return latestByRecordingId;
  }

  Future<Map<int, TranscriptionRecordingRetryResult>>
  retryLatestForRecordingIds(Iterable<int> recordingIds) async {
    final ids = recordingIds.toSet().toList(growable: false);
    final latest = await findLatestByRecordingIds(ids);
    final results = <int, TranscriptionRecordingRetryResult>{};
    for (final recordingId in ids) {
      final job = latest[recordingId];
      if (job == null) {
        results[recordingId] = TranscriptionRecordingRetryResult(
          recordingId: recordingId,
          status: TranscriptionRecordingRetryStatus.jobNotFound,
        );
        continue;
      }
      final retried = await retry(job.id);
      results[recordingId] = TranscriptionRecordingRetryResult(
        recordingId: recordingId,
        status: retried
            ? TranscriptionRecordingRetryStatus.retried
            : TranscriptionRecordingRetryStatus.jobNotRetryable,
        jobId: job.id,
      );
    }
    return results;
  }

  Future<void> deleteByRecordingPath(String recordingPath) async {
    final db = await _database.database;
    await db.delete(
      'transcription_jobs',
      where: 'recording_path = ?',
      whereArgs: <Object>[recordingPath],
    );
  }

  Future<void> updateProgress({
    required int id,
    required String stage,
    required double progress,
  }) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'transcription_jobs',
        columns: <String>['status', 'progress'],
        where: 'id = ?',
        whereArgs: <Object>[id],
        limit: 1,
      );
      if (rows.isEmpty || rows.single['status'] != 'processing') return;
      final current = (rows.single['progress'] as num?)?.toDouble() ?? 0;
      final normalized = progress.clamp(0.0, 1.0);
      if (normalized < current) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.update(
        'transcription_jobs',
        <String, Object?>{
          'stage': stage,
          'progress': normalized,
          'heartbeat_at_ms': now,
          'updated_at_ms': now,
        },
        where: "id = ? AND status = 'processing'",
        whereArgs: <Object>[id],
      );
    });
  }

  Future<TranscriptionCancellationResult> requestCancellation(int id) async {
    final db = await _database.database;
    return db.transaction<TranscriptionCancellationResult>((transaction) async {
      final rows = await transaction.query(
        'transcription_jobs',
        columns: <String>['status'],
        where: 'id = ?',
        whereArgs: <Object>[id],
        limit: 1,
      );
      if (rows.isEmpty) {
        return const TranscriptionCancellationResult(
          accepted: false,
          wasProcessing: false,
        );
      }
      final status = rows.single['status'] as String;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (status == 'pending') {
        await transaction.update(
          'transcription_jobs',
          <String, Object?>{
            'status': 'canceled',
            'stage': 'canceled',
            'cancel_requested': 1,
            'failure_stage': 'cancellation',
            'error_code': 'CANCELED',
            'error_message': '任务已取消',
            'completed_at_ms': now,
            'updated_at_ms': now,
          },
          where: "id = ? AND status = 'pending'",
          whereArgs: <Object>[id],
        );
        return const TranscriptionCancellationResult(
          accepted: true,
          wasProcessing: false,
        );
      }
      if (status == 'processing') {
        await transaction.update(
          'transcription_jobs',
          <String, Object?>{'cancel_requested': 1, 'updated_at_ms': now},
          where: "id = ? AND status = 'processing'",
          whereArgs: <Object>[id],
        );
        return const TranscriptionCancellationResult(
          accepted: true,
          wasProcessing: true,
        );
      }
      return const TranscriptionCancellationResult(
        accepted: false,
        wasProcessing: false,
      );
    });
  }

  Future<bool> isCancellationRequested(int id) async {
    final job = await findById(id);
    return job?.cancelRequested ?? false;
  }

  Future<void> markCanceled(int id) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'canceled',
        'stage': 'canceled',
        'cancel_requested': 1,
        'failure_stage': 'cancellation',
        'error_code': 'CANCELED',
        'error_message': '任务已取消',
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: "id = ? AND status IN ('pending', 'processing')",
      whereArgs: <Object>[id],
    );
  }

  Future<void> complete({required int id, required String resultText}) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'completed',
        'stage': 'completed',
        'progress': 1.0,
        'result_text': resultText,
        'error_message': null,
        'error_code': null,
        'failure_stage': null,
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: "id = ? AND status = 'processing' AND cancel_requested = 0",
      whereArgs: <Object>[id],
    );
  }

  Future<void> fail({
    required int id,
    required String stage,
    required String code,
    required String message,
  }) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'failed',
        'stage': 'failed',
        'failure_stage': stage,
        'error_code': code,
        'error_message': message,
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: "id = ? AND status = 'processing'",
      whereArgs: <Object>[id],
    );
  }

  Future<bool> retry(int id) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final updated = await db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'pending',
        'stage': 'queued',
        'progress': 0.0,
        'cancel_requested': 0,
        'failure_stage': null,
        'error_code': null,
        'error_message': null,
        'result_text': null,
        'started_at_ms': null,
        'completed_at_ms': null,
        'heartbeat_at_ms': null,
        'updated_at_ms': now,
      },
      where: "id = ? AND status IN ('failed', 'canceled')",
      whereArgs: <Object>[id],
    );
    return updated == 1;
  }

  Future<int> requeueStaleProcessing({required int staleBeforeMs}) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    return db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'pending',
        'stage': 'queued',
        'progress': 0.0,
        'cancel_requested': 0,
        'failure_stage': null,
        'error_code': null,
        'error_message': null,
        'started_at_ms': null,
        'completed_at_ms': null,
        'heartbeat_at_ms': null,
        'updated_at_ms': now,
      },
      where:
          "status = 'processing' AND "
          '(heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)',
      whereArgs: <Object>[staleBeforeMs],
    );
  }

  Future<int> requeueInterruptedProcessing({
    required Set<int> activeNativeJobIds,
  }) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final placeholders = List<String>.filled(
      activeNativeJobIds.length,
      '?',
    ).join(', ');
    final where = activeNativeJobIds.isEmpty
        ? "status = 'processing'"
        : "status = 'processing' AND id NOT IN ($placeholders)";
    return db.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'pending',
        'stage': 'queued',
        'progress': 0.0,
        'cancel_requested': 0,
        'failure_stage': null,
        'error_code': null,
        'error_message': null,
        'started_at_ms': null,
        'completed_at_ms': null,
        'heartbeat_at_ms': null,
        'updated_at_ms': now,
      },
      where: where,
      whereArgs: activeNativeJobIds.cast<Object>().toList(),
    );
  }

  Future<bool> hasPending() async {
    final db = await _database.database;
    final rows = await db.rawQuery(
      "SELECT 1 FROM transcription_jobs WHERE status = 'pending' LIMIT 1",
    );
    return rows.isNotEmpty;
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
    final values = <String, Object?>{
      'status': status,
      'result_text': resultText,
      'error_message': errorMessage,
      'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
    };
    if (recordingMode != null) values['recording_mode'] = recordingMode;
    if (source != null) values['source'] = source;
    if (failureStage != null) values['failure_stage'] = failureStage;
    if (progress != null) values['progress'] = progress;
    await db.update(
      'transcription_jobs',
      values,
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }
}

String _dedupeKey(String recordingPath, String source) {
  return '$recordingPath|$source';
}
