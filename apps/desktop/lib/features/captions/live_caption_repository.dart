import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite/sqflite.dart';

import 'live_caption_models.dart';

class LiveCaptionRepository {
  const LiveCaptionRepository({required AppDatabase database})
    : _database = database;

  final AppDatabase _database;

  Future<LiveCaptionSessionRecord> createOrResume({
    required String sessionId,
    required String workspacePath,
    required String modelSha256,
    required String profileId,
    required int nowMs,
  }) async {
    final database = await _database.database;
    return database.transaction((transaction) async {
      final existing = await _find(transaction, sessionId);
      if (existing != null) {
        if (existing.modelSha256 != modelSha256 ||
            existing.profileId != profileId ||
            existing.spoolRelativePath != liveCaptionSpoolRelativePath) {
          throw StateError('Live-caption session configuration drifted');
        }
        return existing;
      }
      final capture = await transaction.query(
        'desktop_capture_sessions',
        columns: <String>['workspace_path'],
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
        limit: 1,
      );
      if (capture.isEmpty ||
          capture.single['workspace_path'] != workspacePath) {
        throw StateError('Live captions require a matching capture session');
      }
      final generationId = await transaction
          .insert('transcript_generations', <String, Object?>{
            'recording_id': null,
            'recording_path': '$workspacePath/$liveCaptionSpoolRelativePath',
            'job_id': null,
            'status': 'recording',
            'source': senseVoiceLiveDraftSource,
            'merged_text': '',
            'has_user_edits': 0,
            'has_evidence_links': 0,
            'generation_kind': 'draft',
            'supersedes_generation_id': null,
            'reconciliation_state': 'not_required',
            'created_at_ms': nowMs,
            'activated_at_ms': null,
            'updated_at_ms': nowMs,
          });
      await transaction
          .insert('desktop_live_caption_sessions', <String, Object?>{
            'session_id': sessionId,
            'generation_id': generationId,
            'recording_id': null,
            'state': LiveCaptionSessionState.preparing.storageValue,
            'spool_relative_path': liveCaptionSpoolRelativePath,
            'worker_offset_bytes': 0,
            'last_sequence': 0,
            'model_sha256': modelSha256,
            'profile_id': profileId,
            'error_code': null,
            'created_at_ms': nowMs,
            'updated_at_ms': nowMs,
          });
      return (await _find(transaction, sessionId))!;
    });
  }

  Future<LiveCaptionSessionRecord?> find(String sessionId) async {
    return _find(await _database.database, sessionId);
  }

  Future<void> markState(
    String sessionId,
    LiveCaptionSessionState state, {
    required int nowMs,
    String? errorCode,
  }) async {
    final database = await _database.database;
    final changed = await database.update(
      'desktop_live_caption_sessions',
      <String, Object?>{
        'state': state.storageValue,
        'error_code': errorCode,
        'updated_at_ms': nowMs,
      },
      where: 'session_id = ?',
      whereArgs: <Object?>[sessionId],
    );
    if (changed != 1) throw StateError('Unknown live-caption session');
  }

  /// Returns false only for an identical replay of an already committed event.
  Future<bool> appendUtterance(
    LiveCaptionUtterance utterance, {
    required int nowMs,
  }) async {
    final database = await _database.database;
    return database.transaction((transaction) async {
      final session = await _find(transaction, utterance.sessionId);
      if (session == null ||
          session.generationId != utterance.generationId ||
          session.modelSha256 != utterance.modelSha256) {
        throw StateError('Live-caption utterance authority mismatch');
      }
      if (session.state == LiveCaptionSessionState.failed ||
          session.state == LiveCaptionSessionState.flushed) {
        throw StateError('Live-caption session no longer accepts utterances');
      }
      final maximumEndMs =
          (utterance.workerOffsetBytes *
                  1000 /
                  liveCaptionBytesPerSample /
                  liveCaptionSampleRate)
              .floor();
      if (utterance.endMs > maximumEndMs ||
          utterance.workerOffsetBytes < session.workerOffsetBytes) {
        throw StateError('Live-caption utterance escaped consumed audio');
      }
      if (utterance.sequence <= session.lastSequence) {
        final duplicate = await transaction.query(
          'transcript_segments',
          where: 'generation_id = ? AND sequence_id = ?',
          whereArgs: <Object?>[utterance.generationId, utterance.sequence],
          limit: 1,
        );
        if (duplicate.isEmpty ||
            duplicate.single['caption_session_id'] != utterance.sessionId ||
            duplicate.single['text'] != utterance.text ||
            duplicate.single['start_ms'] != utterance.startMs ||
            duplicate.single['end_ms'] != utterance.endMs ||
            duplicate.single['language'] != utterance.language ||
            duplicate.single['model_sha256'] != utterance.modelSha256 ||
            duplicate.single['worker_offset_bytes'] !=
                utterance.workerOffsetBytes) {
          throw StateError('Live-caption sequence replay drifted');
        }
        return false;
      }
      if (utterance.sequence != session.lastSequence + 1) {
        throw StateError('Live-caption utterances must be contiguous');
      }
      await transaction.insert('transcript_segments', <String, Object?>{
        'recording_id': session.recordingId,
        'recording_path': (await _generationPath(
          transaction,
          session.generationId,
        )),
        'generation_id': session.generationId,
        'job_id': null,
        'sequence_id': utterance.sequence,
        'text': utterance.text,
        'start_ms': utterance.startMs,
        'end_ms': utterance.endMs,
        'is_final': 1,
        'source': senseVoiceLiveDraftSource,
        'confidence': null,
        'review_state': 'unreviewed',
        'reviewed_at_ms': null,
        'language': utterance.language,
        'model_sha256': utterance.modelSha256,
        'caption_session_id': utterance.sessionId,
        'worker_offset_bytes': utterance.workerOffsetBytes,
        'created_at_ms': nowMs,
        'updated_at_ms': nowMs,
      });
      await transaction.update(
        'desktop_live_caption_sessions',
        <String, Object?>{
          'state': LiveCaptionSessionState.running.storageValue,
          'last_sequence': utterance.sequence,
          'worker_offset_bytes': utterance.workerOffsetBytes,
          'error_code': null,
          'updated_at_ms': nowMs,
        },
        where: 'session_id = ?',
        whereArgs: <Object?>[utterance.sessionId],
      );
      await _refreshMergedText(transaction, session.generationId, nowMs);
      return true;
    });
  }

  Future<void> saveWorkerOffset({
    required String sessionId,
    required int workerOffsetBytes,
    required int nowMs,
  }) async {
    if (workerOffsetBytes < 0 || workerOffsetBytes.isOdd) {
      throw const FormatException('Invalid live-caption worker offset');
    }
    final database = await _database.database;
    final changed = await database.rawUpdate(
      '''
      UPDATE desktop_live_caption_sessions
      SET worker_offset_bytes = ?, updated_at_ms = ?
      WHERE session_id = ? AND worker_offset_bytes <= ?
      ''',
      <Object?>[workerOffsetBytes, nowMs, sessionId, workerOffsetBytes],
    );
    if (changed != 1) {
      throw StateError('Live-caption worker offset moved backwards');
    }
  }

  Future<void> attachCommittedRecording({
    required String sessionId,
    required int recordingId,
    required String recordingPath,
    required int nowMs,
  }) async {
    final database = await _database.database;
    await database.transaction((transaction) async {
      final session = await _find(transaction, sessionId);
      if (session == null) throw StateError('Unknown live-caption session');
      if (session.recordingId != null && session.recordingId != recordingId) {
        throw StateError('Live-caption recording attachment drifted');
      }
      final recording = await transaction.query(
        'recordings',
        columns: <String>['active_generation_id'],
        where: 'id = ? AND session_id = ?',
        whereArgs: <Object?>[recordingId, sessionId],
        limit: 1,
      );
      if (recording.isEmpty) {
        throw StateError('Committed capture recording is missing');
      }
      await transaction.update(
        'desktop_live_caption_sessions',
        <String, Object?>{'recording_id': recordingId, 'updated_at_ms': nowMs},
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
      );
      await transaction.update(
        'transcript_generations',
        <String, Object?>{
          'recording_id': recordingId,
          'recording_path': recordingPath,
          'updated_at_ms': nowMs,
        },
        where: 'id = ?',
        whereArgs: <Object?>[session.generationId],
      );
      await transaction.update(
        'transcript_segments',
        <String, Object?>{
          'recording_id': recordingId,
          'recording_path': recordingPath,
          'updated_at_ms': nowMs,
        },
        where: 'generation_id = ?',
        whereArgs: <Object?>[session.generationId],
      );
    });
  }

  Future<void> markFlushed(String sessionId, {required int nowMs}) async {
    final database = await _database.database;
    await database.transaction((transaction) async {
      final session = await _find(transaction, sessionId);
      if (session == null) throw StateError('Unknown live-caption session');
      await transaction.update(
        'desktop_live_caption_sessions',
        <String, Object?>{
          'state': LiveCaptionSessionState.flushed.storageValue,
          'error_code': null,
          'updated_at_ms': nowMs,
        },
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
      );
      await transaction.update(
        'transcript_generations',
        <String, Object?>{'status': 'completed', 'updated_at_ms': nowMs},
        where: 'id = ?',
        whereArgs: <Object?>[session.generationId],
      );
    });
  }

  Future<TranscriptDisplaySnapshot> displayForRecording(int recordingId) async {
    final database = await _database.database;
    final rows = await database.rawQuery(
      '''
      SELECT
        COALESCE(active.id, draft.id) AS id,
        COALESCE(active.source, draft.source) AS source,
        COALESCE(active.generation_kind, draft.generation_kind)
          AS generation_kind,
        COALESCE(
          active.reconciliation_state,
          draft.reconciliation_state
        ) AS reconciliation_state
      FROM recordings AS r
      LEFT JOIN transcript_generations AS active
        ON active.id = r.active_generation_id
      LEFT JOIN transcript_generations AS draft
        ON draft.id = (
          SELECT candidate.id
          FROM transcript_generations AS candidate
          WHERE candidate.recording_id = r.id
            AND candidate.generation_kind = 'draft'
          ORDER BY candidate.id DESC
          LIMIT 1
        )
      WHERE r.id = ?
      LIMIT 1
      ''',
      <Object?>[recordingId],
    );
    if (rows.isEmpty || rows.single['id'] == null) {
      return const TranscriptDisplaySnapshot.none();
    }
    final row = rows.single;
    final isDraft = row['generation_kind'] == 'draft';
    final pending = await database.query(
      'transcript_generations',
      columns: <String>['id'],
      where: 'recording_id = ? AND reconciliation_state = ?',
      whereArgs: <Object?>[recordingId, 'pending'],
      limit: 1,
    );
    return TranscriptDisplaySnapshot(
      authority: pending.isNotEmpty
          ? TranscriptDisplayAuthority.revisionRequired
          : isDraft
          ? TranscriptDisplayAuthority.liveDraft
          : TranscriptDisplayAuthority.formal,
      generationId: row['id']! as int,
      source: row['source']! as String,
      isDraft: isDraft,
      requiresReconciliation: pending.isNotEmpty,
    );
  }

  Future<void> reconcile({
    required int formalGenerationId,
    required TranscriptReconciliationChoice choice,
    required int nowMs,
  }) async {
    final database = await _database.database;
    await database.transaction((transaction) async {
      final rows = await transaction.query(
        'transcript_generations',
        columns: <String>[
          'recording_id',
          'supersedes_generation_id',
          'generation_kind',
        ],
        where: 'id = ?',
        whereArgs: <Object?>[formalGenerationId],
        limit: 1,
      );
      if (rows.isEmpty ||
          rows.single['generation_kind'] != 'formal' ||
          rows.single['recording_id'] == null ||
          rows.single['supersedes_generation_id'] == null) {
        throw StateError('Formal generation has no draft to reconcile');
      }
      final activeId = choice == TranscriptReconciliationChoice.acceptFormal
          ? formalGenerationId
          : rows.single['supersedes_generation_id']! as int;
      await transaction.update(
        'recordings',
        <String, Object?>{'active_generation_id': activeId},
        where: 'id = ?',
        whereArgs: <Object?>[rows.single['recording_id']!],
      );
      await transaction.update(
        'transcript_generations',
        <String, Object?>{
          'reconciliation_state':
              choice == TranscriptReconciliationChoice.acceptFormal
              ? 'accepted_formal'
              : 'kept_draft',
          'activated_at_ms':
              choice == TranscriptReconciliationChoice.acceptFormal
              ? nowMs
              : null,
          'updated_at_ms': nowMs,
        },
        where: 'id = ?',
        whereArgs: <Object?>[formalGenerationId],
      );
    });
  }

  static Future<LiveCaptionSessionRecord?> _find(
    DatabaseExecutor database,
    String sessionId,
  ) async {
    final rows = await database.query(
      'desktop_live_caption_sessions',
      where: 'session_id = ?',
      whereArgs: <Object?>[sessionId],
      limit: 1,
    );
    return rows.isEmpty ? null : LiveCaptionSessionRecord.fromRow(rows.single);
  }

  static Future<String> _generationPath(
    DatabaseExecutor database,
    int generationId,
  ) async {
    final rows = await database.query(
      'transcript_generations',
      columns: <String>['recording_path'],
      where: 'id = ?',
      whereArgs: <Object?>[generationId],
      limit: 1,
    );
    if (rows.isEmpty) throw StateError('Live-caption generation is missing');
    return rows.single['recording_path']! as String;
  }

  static Future<void> _refreshMergedText(
    DatabaseExecutor database,
    int generationId,
    int nowMs,
  ) async {
    final segments = await database.query(
      'transcript_segments',
      columns: <String>['text'],
      where: 'generation_id = ?',
      whereArgs: <Object?>[generationId],
      orderBy: 'sequence_id ASC',
    );
    await database.update(
      'transcript_generations',
      <String, Object?>{
        'merged_text': segments
            .map((row) => (row['text']! as String).trim())
            .where((text) => text.isNotEmpty)
            .join(' '),
        'updated_at_ms': nowMs,
      },
      where: 'id = ?',
      whereArgs: <Object?>[generationId],
    );
  }
}
