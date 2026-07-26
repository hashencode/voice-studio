import 'dart:math';

import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite/sqflite.dart';

import 'desktop_job.dart';
import 'desktop_processing_engine.dart';

class DesktopImportCommitResult {
  const DesktopImportCommitResult({
    required this.recordingId,
    required this.inserted,
    this.existingPath,
    this.processingJob,
  });

  final int recordingId;
  final bool inserted;
  final String? existingPath;
  final ProcessingJobReference? processingJob;
}

class DesktopProcessingRepository {
  const DesktopProcessingRepository({required AppDatabase database})
    : _database = database;

  final AppDatabase _database;

  Future<int> countActiveJobs() async {
    final database = await _database.database;
    final rows = await database.rawQuery('''
      SELECT COUNT(*) AS count
      FROM transcription_jobs
      WHERE source = 'desktop_local_import'
        AND status IN ('pending', 'processing')
    ''');
    return (rows.single['count']! as num).toInt();
  }

  Future<String?> recordingHash(int recordingId) async {
    final database = await _database.database;
    final rows = await database.query(
      'recordings',
      columns: <String>['fingerprint_sha256'],
      where: 'id = ?',
      whereArgs: <Object>[recordingId],
      limit: 1,
    );
    return rows.isEmpty ? null : rows.single['fingerprint_sha256'] as String?;
  }

  Future<DesktopImportCommitResult> commitImported(
    MeetingMediaCandidate candidate,
  ) async {
    final database = await _database.database;
    return database.transaction<DesktopImportCommitResult>((transaction) async {
      final duplicate = await transaction.query(
        'recordings',
        columns: <String>['id', 'file_path'],
        where: 'fingerprint_sha256 = ?',
        whereArgs: <Object>[candidate.fingerprintSha256],
        limit: 1,
      );
      if (duplicate.isNotEmpty) {
        return DesktopImportCommitResult(
          recordingId: duplicate.single['id']! as int,
          inserted: false,
          existingPath: duplicate.single['file_path']! as String,
        );
      }

      final now = DateTime.now().millisecondsSinceEpoch;
      final recordingId = await transaction
          .insert('recordings', <String, Object?>{
            'file_path': candidate.path,
            'display_name': candidate.displayName,
            'group_name': null,
            'deleted_at_ms': null,
            'is_favorite': 0,
            'session_id': null,
            'asset_kind': 'imported',
            'fingerprint_sha256': candidate.fingerprintSha256,
            'source_display_name': candidate.displayName,
            'deletion_state': 'active',
            'duration_ms': candidate.durationMs,
            'created_at_ms': now,
          });
      final jobId = await transaction
          .insert('transcription_jobs', <String, Object?>{
            'recording_path': candidate.path,
            'duration_ms': candidate.durationMs,
            'status': 'pending',
            'recording_mode': 'standard',
            'source': 'desktop_local_import',
            'failure_stage': null,
            'stage': 'queued',
            'progress': 0.0,
            'attempt_count': 0,
            'cancel_requested': 0,
            'error_code': null,
            'dedupe_key':
                '${candidate.fingerprintSha256}|desktop_local_processing',
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
      return DesktopImportCommitResult(
        recordingId: recordingId,
        inserted: true,
        processingJob: ProcessingJobReference(
          id: jobId,
          state: ProcessingJobState.queued,
          inputSha256: candidate.fingerprintSha256,
        ),
      );
    });
  }

  Future<List<DesktopProcessingJob>> listJobs() async {
    final database = await _database.database;
    final rows = await database.rawQuery('''
      SELECT
        j.id,
        j.recording_id,
        j.recording_path,
        j.status,
        j.stage,
        j.progress,
        j.error_code,
        j.created_at_ms,
        r.display_name,
        r.fingerprint_sha256
      FROM transcription_jobs AS j
      INNER JOIN recordings AS r ON r.id = j.recording_id
      WHERE j.source = 'desktop_local_import'
      ORDER BY j.created_at_ms DESC, j.id DESC
    ''');
    return rows
        .map(
          (row) => DesktopProcessingJob(
            id: row['id']! as int,
            recordingId: row['recording_id']! as int,
            displayName: row['display_name']! as String,
            recordingPath: row['recording_path']! as String,
            fingerprintSha256: row['fingerprint_sha256']! as String,
            state: DesktopJobState.fromWireValue(row['status']! as String),
            stage: row['stage']! as String,
            progress: (row['progress']! as num).toDouble(),
            createdAtMs: row['created_at_ms']! as int,
            errorCode: row['error_code'] as String?,
          ),
        )
        .toList(growable: false);
  }

  Future<DesktopProcessingJob?> claimNext() async {
    final database = await _database.database;
    return database.transaction<DesktopProcessingJob?>((transaction) async {
      final rows = await transaction.rawQuery('''
        SELECT j.id
        FROM transcription_jobs AS j
        WHERE j.source = 'desktop_local_import'
          AND j.status = 'pending'
        ORDER BY j.created_at_ms ASC, j.id ASC
        LIMIT 1
      ''');
      if (rows.isEmpty) return null;
      final id = rows.single['id']! as int;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.rawUpdate(
        '''
        UPDATE transcription_jobs
        SET status = 'processing',
            stage = 'preparing',
            progress = 0.0,
            attempt_count = attempt_count + 1,
            started_at_ms = ?,
            heartbeat_at_ms = ?,
            updated_at_ms = ?
        WHERE id = ? AND status = 'pending'
        ''',
        <Object>[now, now, now, id],
      );
      return _findById(transaction, id);
    });
  }

  Future<void> updateProgress(
    int jobId, {
    required String phase,
    required double progress,
  }) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.update(
      'transcription_jobs',
      <String, Object?>{
        'stage': switch (phase) {
          'asr' => 'asr',
          'diarization' => 'diarization',
          _ => 'preparing',
        },
        'progress': progress.clamp(0.0, 0.99),
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ? AND status = ? AND cancel_requested = 0',
      whereArgs: <Object>[jobId, 'processing'],
    );
  }

  Future<void> completeWithResult(
    DesktopProcessingJob job,
    DesktopProcessingResult result,
  ) async {
    final database = await _database.database;
    await database.transaction<void>((transaction) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final jobRows = await transaction.query(
        'transcription_jobs',
        columns: <String>['status', 'generation_id', 'cancel_requested'],
        where: 'id = ? AND recording_id = ?',
        whereArgs: <Object>[job.id, job.recordingId],
        limit: 1,
      );
      if (jobRows.isEmpty ||
          jobRows.single['status'] != 'processing' ||
          jobRows.single['cancel_requested'] == 1) {
        throw const ProcessingCancelled();
      }
      var generationId = jobRows.single['generation_id'] as int?;
      if (generationId == null) {
        generationId = await transaction
            .insert('transcript_generations', <String, Object?>{
              'recording_id': job.recordingId,
              'recording_path': job.recordingPath,
              'job_id': job.id,
              'status': result.diarizationSucceeded
                  ? 'completed'
                  : 'partial_success',
              'source': result.engineId,
              'merged_text': result.segments
                  .map((segment) => segment.text.trim())
                  .where((text) => text.isNotEmpty)
                  .join(' '),
              'has_user_edits': 0,
              'has_evidence_links': 0,
              'created_at_ms': now,
              'activated_at_ms': now,
              'updated_at_ms': now,
            });
        await transaction.update(
          'transcription_jobs',
          <String, Object?>{'generation_id': generationId},
          where: 'id = ?',
          whereArgs: <Object>[job.id],
        );
      } else {
        final generationRows = await transaction.query(
          'transcript_generations',
          columns: <String>['has_user_edits'],
          where: 'id = ?',
          whereArgs: <Object>[generationId],
          limit: 1,
        );
        if (generationRows.isEmpty) {
          throw StateError('processing generation is missing');
        }
        if (generationRows.single['has_user_edits'] != 1) {
          await transaction.delete(
            'transcript_segments',
            where: 'generation_id = ?',
            whereArgs: <Object>[generationId],
          );
        }
      }

      var segmentRows = await transaction.query(
        'transcript_segments',
        columns: <String>['id'],
        where: 'generation_id = ?',
        whereArgs: <Object>[generationId],
        orderBy: 'sequence_id ASC, id ASC',
      );
      if (segmentRows.isEmpty) {
        for (var index = 0; index < result.segments.length; index += 1) {
          final segment = result.segments[index];
          await transaction.insert('transcript_segments', <String, Object?>{
            'recording_id': job.recordingId,
            'recording_path': job.recordingPath,
            'generation_id': generationId,
            'job_id': job.id,
            'sequence_id': index,
            'text': segment.text,
            'start_ms': (segment.startSeconds * 1000).round(),
            'end_ms': max(
              (segment.startSeconds * 1000).round() + 1,
              (segment.endSeconds * 1000).round(),
            ),
            'is_final': 1,
            'source': result.engineId,
            'confidence': null,
            'review_state':
                segment.speakerAssignment == SpeakerAssignment.unknown
                ? 'needs_review'
                : 'unreviewed',
            'reviewed_at_ms': null,
            'created_at_ms': now,
            'updated_at_ms': now,
          });
        }
        segmentRows = await transaction.query(
          'transcript_segments',
          columns: <String>['id'],
          where: 'generation_id = ?',
          whereArgs: <Object>[generationId],
          orderBy: 'sequence_id ASC, id ASC',
        );
      }
      if (segmentRows.length != result.segments.length) {
        throw StateError(
          'protected transcript no longer matches processing output',
        );
      }
      await _replaceAutomaticSpeakers(
        transaction,
        recordingId: job.recordingId,
        generationId: generationId,
        segmentIds: segmentRows
            .map((row) => row['id']! as int)
            .toList(growable: false),
        segments: result.segments,
        now: now,
      );
      final mergedText = await _mergedText(transaction, generationId);
      await transaction.update(
        'transcript_generations',
        <String, Object?>{
          'status': result.diarizationSucceeded
              ? 'completed'
              : 'partial_success',
          'source': result.engineId,
          'merged_text': mergedText,
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
        whereArgs: <Object>[job.recordingId],
      );
      await transaction.update(
        'transcription_jobs',
        <String, Object?>{
          'status': 'completed',
          'stage': result.diarizationSucceeded
              ? 'completed'
              : 'partial_success',
          'progress': 1.0,
          'error_code': result.diarizationErrorCode,
          'error_message': result.diarizationSucceeded
              ? null
              : '转写已完成，说话人分离失败；音频与转写均已保留，可单独重试',
          'result_text': mergedText,
          'completed_at_ms': now,
          'heartbeat_at_ms': now,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[job.id],
      );
    });
  }

  Future<void> markFailed(
    int jobId, {
    required String code,
    required String message,
    required bool retryable,
  }) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'failed',
        'stage': retryable ? 'retryable_failure' : 'terminal_failure',
        'failure_stage': 'processing',
        'error_code': code,
        'error_message': message,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[jobId],
    );
  }

  Future<void> markCanceling() async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.update(
      'transcription_jobs',
      <String, Object?>{
        'stage': 'canceling',
        'cancel_requested': 1,
        'updated_at_ms': now,
      },
      where: "source = 'desktop_local_import' AND status = 'processing'",
    );
  }

  Future<void> markCanceled(int jobId) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'canceled',
        'stage': 'canceled',
        'progress': 0.0,
        'cancel_requested': 1,
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[jobId],
    );
  }

  Future<bool> retry(int jobId) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final updated = await database.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'pending',
        'stage': 'queued',
        'progress': 0.0,
        'cancel_requested': 0,
        'error_code': null,
        'error_message': null,
        'completed_at_ms': null,
        'updated_at_ms': now,
      },
      where:
          "id = ? AND (status = 'failed' OR stage = 'partial_success' "
          "OR stage = 'recovery_unknown')",
      whereArgs: <Object>[jobId],
    );
    return updated == 1;
  }

  Future<int> reconcileInterruptedJobs() async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    return database.update(
      'transcription_jobs',
      <String, Object?>{
        'status': 'failed',
        'stage': 'recovery_unknown',
        'failure_stage': 'startup_reconciliation',
        'error_code': 'PROCESS_INTERRUPTED',
        'error_message': '应用退出时任务状态未知；已停止自动发布，可安全重试',
        'updated_at_ms': now,
      },
      where: 'source = ? AND status = ?',
      whereArgs: <Object>['desktop_local_import', 'processing'],
    );
  }

  Future<void> _replaceAutomaticSpeakers(
    DatabaseExecutor transaction, {
    required int recordingId,
    required int generationId,
    required List<int> segmentIds,
    required List<ProcessingTranscriptSegment> segments,
    required int now,
  }) async {
    await transaction.delete(
      'transcript_speaker_assignments',
      where: "generation_id = ? AND source = 'automatic'",
      whereArgs: <Object>[generationId],
    );
    await transaction.delete(
      'speaker_turns',
      where: "generation_id = ? AND source = 'automatic'",
      whereArgs: <Object>[generationId],
    );
    final keys =
        segments
            .map((segment) => segment.anonymousSpeakerKey)
            .whereType<String>()
            .toSet()
            .toList()
          ..sort();
    final speakerIds = <String, int>{};
    for (var index = 0; index < keys.length; index += 1) {
      final key = keys[index];
      await transaction.insert('meeting_speakers', <String, Object?>{
        'recording_id': recordingId,
        'generation_id': generationId,
        'stable_key': key,
        'display_name': '说话人 ${index + 1}',
        'source': 'automatic',
        'merged_into_speaker_id': null,
        'created_at_ms': now,
        'updated_at_ms': now,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      final rows = await transaction.query(
        'meeting_speakers',
        columns: <String>['id'],
        where:
            'generation_id = ? AND stable_key = ? '
            'AND merged_into_speaker_id IS NULL',
        whereArgs: <Object>[generationId, key],
        limit: 1,
      );
      if (rows.isNotEmpty) speakerIds[key] = rows.single['id']! as int;
    }
    for (var index = 0; index < segments.length; index += 1) {
      final segment = segments[index];
      final startMs = (segment.startSeconds * 1000).round();
      final endMs = max(startMs + 1, (segment.endSeconds * 1000).round());
      final speakerId = segment.anonymousSpeakerKey == null
          ? null
          : speakerIds[segment.anonymousSpeakerKey!];
      if (speakerId != null) {
        await transaction.insert('speaker_turns', <String, Object?>{
          'recording_id': recordingId,
          'generation_id': generationId,
          'speaker_id': speakerId,
          'start_ms': startMs,
          'end_ms': endMs,
          'source': 'automatic',
          'confidence': null,
          'created_at_ms': now,
          'updated_at_ms': now,
        });
      }
      final manual = await transaction.query(
        'transcript_speaker_assignments',
        columns: <String>['id'],
        where: "segment_id = ? AND source = 'manual'",
        whereArgs: <Object>[segmentIds[index]],
        limit: 1,
      );
      if (manual.isNotEmpty) continue;
      await transaction
          .insert('transcript_speaker_assignments', <String, Object?>{
            'recording_id': recordingId,
            'generation_id': generationId,
            'segment_id': segmentIds[index],
            'speaker_id': speakerId,
            'start_ms': startMs,
            'end_ms': endMs,
            'state': switch (segment.speakerAssignment) {
              SpeakerAssignment.anonymous => 'assigned',
              SpeakerAssignment.overlap => 'overlap',
              SpeakerAssignment.unknown => 'unknown',
            },
            'source': 'automatic',
            'created_at_ms': now,
            'updated_at_ms': now,
          });
    }
  }

  Future<String> _mergedText(
    DatabaseExecutor transaction,
    int generationId,
  ) async {
    final rows = await transaction.query(
      'transcript_segments',
      columns: <String>['text'],
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'sequence_id ASC, id ASC',
    );
    return rows
        .map((row) => (row['text']! as String).trim())
        .where((text) => text.isNotEmpty)
        .join(' ');
  }

  Future<DesktopProcessingJob?> _findById(
    DatabaseExecutor executor,
    int id,
  ) async {
    final rows = await executor.rawQuery(
      '''
      SELECT
        j.id,
        j.recording_id,
        j.recording_path,
        j.status,
        j.stage,
        j.progress,
        j.error_code,
        j.created_at_ms,
        r.display_name,
        r.fingerprint_sha256
      FROM transcription_jobs AS j
      INNER JOIN recordings AS r ON r.id = j.recording_id
      WHERE j.id = ?
      LIMIT 1
      ''',
      <Object>[id],
    );
    if (rows.isEmpty) return null;
    final row = rows.single;
    return DesktopProcessingJob(
      id: row['id']! as int,
      recordingId: row['recording_id']! as int,
      displayName: row['display_name']! as String,
      recordingPath: row['recording_path']! as String,
      fingerprintSha256: row['fingerprint_sha256']! as String,
      state: DesktopJobState.fromWireValue(row['status']! as String),
      stage: row['stage']! as String,
      progress: (row['progress']! as num).toDouble(),
      createdAtMs: row['created_at_ms']! as int,
      errorCode: row['error_code'] as String?,
    );
  }
}
