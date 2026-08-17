import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/meeting_intelligence_job_entity.dart';
import '../service/meeting_intelligence_provider.dart';

class MeetingIntelligenceJobsRepository {
  MeetingIntelligenceJobsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  String buildDedupeKey({
    required MeetingIntelligenceProvider provider,
    required MeetingIntelligenceRequest request,
  }) {
    final canonical = jsonEncode(<String, Object?>{
      'generation_id': request.generationId,
      'input_start_ms': request.inputStartMs,
      'input_end_ms': request.inputEndMs,
      'template_id': request.templateId.name,
      'provider_id': provider.providerId,
      'model_id': provider.modelId,
      'processing_location': request.processingLocation.name,
      'segments': request.segments
          .map(
            (segment) => <String, Object?>{
              'id': segment.id,
              'start_ms': segment.startMs,
              'end_ms': segment.endMs,
              'updated_at_ms': segment.updatedAtMs,
              'text': segment.text,
            },
          )
          .toList(growable: false),
    });
    return sha256.convert(utf8.encode(canonical)).toString();
  }

  Future<MeetingIntelligenceJobEntity> createOrGet({
    required MeetingIntelligenceProvider provider,
    required MeetingIntelligenceRequest request,
    required int estimatedRequestCount,
    required String payloadSummary,
  }) async {
    if (request.consentDecision != MeetingConsentDecision.granted ||
        request.consentAtMs == null) {
      throw StateError('创建云端任务前必须获得本次会议同意');
    }
    final dedupeKey = buildDedupeKey(provider: provider, request: request);
    final db = await _database.database;
    return db.transaction<MeetingIntelligenceJobEntity>((transaction) async {
      final existing = await _findByDedupeKey(transaction, dedupeKey);
      if (existing != null) return existing;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('meeting_intelligence_jobs', <String, Object?>{
        'recording_id': request.recordingId,
        'generation_id': request.generationId,
        'provider_id': provider.providerId,
        'model_id': provider.modelId,
        'processing_location': request.processingLocation.name,
        'template_id': request.templateId.name,
        'status': MeetingIntelligenceJobStatus.queued.name,
        'progress': 0.0,
        'attempt_count': 0,
        'cancel_requested': 0,
        'dedupe_key': dedupeKey,
        'input_start_ms': request.inputStartMs,
        'input_end_ms': request.inputEndMs,
        'segment_count': request.segments.length,
        'estimated_request_count': estimatedRequestCount,
        'speaker_labels_included': request.speakerLabelsIncluded ? 1 : 0,
        'consent_version': request.consentVersion,
        'consent_at_ms': request.consentAtMs,
        'payload_summary': payloadSummary,
        'created_at_ms': now,
        'updated_at_ms': now,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      final created = await _findByDedupeKey(transaction, dedupeKey);
      if (created == null) throw StateError('无法创建会议智能任务');
      return created;
    });
  }

  Future<MeetingIntelligenceJobEntity?> findById(int id) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_intelligence_jobs',
      where: 'id = ?',
      whereArgs: <Object>[id],
      limit: 1,
    );
    return rows.isEmpty
        ? null
        : MeetingIntelligenceJobEntity.fromMap(rows.single);
  }

  Future<MeetingIntelligenceJobEntity?> findLatestForRecording(
    int recordingId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_intelligence_jobs',
      where: 'recording_id = ?',
      whereArgs: <Object>[recordingId],
      orderBy: 'created_at_ms DESC, id DESC',
      limit: 1,
    );
    return rows.isEmpty
        ? null
        : MeetingIntelligenceJobEntity.fromMap(rows.single);
  }

  Future<List<MeetingIntelligenceJobEntity>> listUnfinished() async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_intelligence_jobs',
      where: 'status IN (?, ?)',
      whereArgs: <Object>[
        MeetingIntelligenceJobStatus.queued.name,
        MeetingIntelligenceJobStatus.processing.name,
      ],
      orderBy: 'created_at_ms ASC, id ASC',
    );
    return rows
        .map(MeetingIntelligenceJobEntity.fromMap)
        .toList(growable: false);
  }

  Future<MeetingIntelligenceJobEntity> markProcessing(int id) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final updated = await db.rawUpdate(
      '''
      UPDATE meeting_intelligence_jobs
      SET status = ?,
          attempt_count = attempt_count + 1,
          started_at_ms = ?,
          heartbeat_at_ms = ?,
          cancel_requested = 0,
          error_code = NULL,
          updated_at_ms = ?
      WHERE id = ? AND status = ?
      ''',
      <Object>[
        MeetingIntelligenceJobStatus.processing.name,
        now,
        now,
        now,
        id,
        MeetingIntelligenceJobStatus.queued.name,
      ],
    );
    if (updated != 1) throw StateError('会议智能任务状态已变化');
    return (await findById(id))!;
  }

  Future<void> updateProgress(int id, double progress) async {
    final normalized = progress.clamp(0.0, 1.0);
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'meeting_intelligence_jobs',
      <String, Object?>{
        'progress': normalized,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ? AND status = ?',
      whereArgs: <Object>[id, MeetingIntelligenceJobStatus.processing.name],
    );
  }

  Future<void> markCompleted(int id) {
    final now = DateTime.now().millisecondsSinceEpoch;
    return _updateExpected(
      id: id,
      expected: const <MeetingIntelligenceJobStatus>{
        MeetingIntelligenceJobStatus.processing,
      },
      values: <String, Object?>{
        'status': MeetingIntelligenceJobStatus.completed.name,
        'progress': 1.0,
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
    );
  }

  Future<void> markFailed(int id, String errorCode) {
    final now = DateTime.now().millisecondsSinceEpoch;
    return _updateExpected(
      id: id,
      expected: const <MeetingIntelligenceJobStatus>{
        MeetingIntelligenceJobStatus.processing,
        MeetingIntelligenceJobStatus.queued,
      },
      values: <String, Object?>{
        'status': MeetingIntelligenceJobStatus.failed.name,
        'error_code': errorCode,
        'completed_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
    );
  }

  Future<void> requestCancel(int id) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'meeting_intelligence_jobs',
        columns: <String>['status'],
        where: 'id = ?',
        whereArgs: <Object>[id],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('会议智能任务不存在');
      final status = MeetingIntelligenceJobStatus.fromStorage(
        rows.single['status'],
      );
      final now = DateTime.now().millisecondsSinceEpoch;
      if (status == MeetingIntelligenceJobStatus.queued) {
        await transaction.update(
          'meeting_intelligence_jobs',
          <String, Object?>{
            'status': MeetingIntelligenceJobStatus.canceled.name,
            'cancel_requested': 1,
            'completed_at_ms': now,
            'updated_at_ms': now,
          },
          where: 'id = ?',
          whereArgs: <Object>[id],
        );
      } else if (status == MeetingIntelligenceJobStatus.processing) {
        await transaction.update(
          'meeting_intelligence_jobs',
          <String, Object?>{'cancel_requested': 1, 'updated_at_ms': now},
          where: 'id = ?',
          whereArgs: <Object>[id],
        );
      }
    });
  }

  Future<void> markCanceled(int id) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'meeting_intelligence_jobs',
      <String, Object?>{
        'status': MeetingIntelligenceJobStatus.canceled.name,
        'cancel_requested': 1,
        'completed_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ? AND status IN (?, ?)',
      whereArgs: <Object>[
        id,
        MeetingIntelligenceJobStatus.queued.name,
        MeetingIntelligenceJobStatus.processing.name,
      ],
    );
  }

  Future<void> requeueForUserRetry(int id) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _updateExpected(
      id: id,
      expected: const <MeetingIntelligenceJobStatus>{
        MeetingIntelligenceJobStatus.failed,
        MeetingIntelligenceJobStatus.recoveryUnknown,
      },
      values: <String, Object?>{
        'status': MeetingIntelligenceJobStatus.queued.name,
        'progress': 0.0,
        'cancel_requested': 0,
        'error_code': null,
        'started_at_ms': null,
        'completed_at_ms': null,
        'heartbeat_at_ms': null,
        'updated_at_ms': now,
      },
    );
  }

  Future<void> reconcileQueued(int id) async {
    final db = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.update(
      'meeting_intelligence_jobs',
      <String, Object?>{
        'status': MeetingIntelligenceJobStatus.queued.name,
        'progress': 0.0,
        'cancel_requested': 0,
        'updated_at_ms': now,
      },
      where: 'id = ? AND status = ?',
      whereArgs: <Object>[id, MeetingIntelligenceJobStatus.queued.name],
    );
  }

  Future<void> markRecoveryUnknown(int id) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _updateExpected(
      id: id,
      expected: const <MeetingIntelligenceJobStatus>{
        MeetingIntelligenceJobStatus.processing,
      },
      values: <String, Object?>{
        'status': MeetingIntelligenceJobStatus.recoveryUnknown.name,
        'error_code': 'process_interrupted_after_request_start',
        'updated_at_ms': now,
      },
    );
  }

  Future<MeetingIntelligenceJobEntity?> _findByDedupeKey(
    DatabaseExecutor executor,
    String dedupeKey,
  ) async {
    final rows = await executor.query(
      'meeting_intelligence_jobs',
      where: 'dedupe_key = ?',
      whereArgs: <Object>[dedupeKey],
      limit: 1,
    );
    return rows.isEmpty
        ? null
        : MeetingIntelligenceJobEntity.fromMap(rows.single);
  }

  Future<void> _updateExpected({
    required int id,
    required Set<MeetingIntelligenceJobStatus> expected,
    required Map<String, Object?> values,
  }) async {
    final db = await _database.database;
    final placeholders = List<String>.filled(expected.length, '?').join(', ');
    final updated = await db.update(
      'meeting_intelligence_jobs',
      values,
      where: 'id = ? AND status IN ($placeholders)',
      whereArgs: <Object>[id, ...expected.map((status) => status.name)],
    );
    if (updated != 1) {
      throw StateError('会议智能任务状态已变化');
    }
  }
}
