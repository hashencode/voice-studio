import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/evidence_link_entity.dart';
import '../model/meeting_insight_entity.dart';
import '../model/meeting_note_entity.dart';
import '../model/meeting_note_revision_entity.dart';
import '../service/meeting_intelligence_provider.dart';
import '../service/meeting_intelligence_validator.dart';

class MeetingIntelligenceBundle {
  const MeetingIntelligenceBundle({
    required this.note,
    required this.insights,
    required this.evidenceByInsight,
  });

  final MeetingNoteEntity note;
  final List<MeetingInsightEntity> insights;
  final Map<int, List<EvidenceLinkEntity>> evidenceByInsight;
}

class MeetingIntelligenceRepository {
  MeetingIntelligenceRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<MeetingIntelligenceBundle> createDraft({
    required MeetingIntelligenceProvider provider,
    required MeetingIntelligenceRequest request,
    required ValidatedMeetingIntelligence validated,
    int? jobId,
  }) async {
    final db = await _database.database;
    return db.transaction<MeetingIntelligenceBundle>((transaction) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final noteId = await transaction.insert(
        'meeting_notes',
        <String, Object?>{
          'recording_id': request.recordingId,
          'generation_id': request.generationId,
          'job_id': jobId,
          'status': MeetingNoteStatus.draft.name,
          'provider_id': provider.providerId,
          'model_id': provider.modelId,
          'processing_location': request.processingLocation.name,
          'consent_granted':
              request.consentDecision == MeetingConsentDecision.granted ? 1 : 0,
          'consent_version': request.consentVersion,
          'consent_at_ms': request.consentAtMs,
          'payload_summary': request.payloadSummary,
          'input_start_ms': request.inputStartMs,
          'input_end_ms': request.inputEndMs,
          'output_schema_version': validated.schemaVersion,
          'template_id': request.templateId.name,
          'meeting_type': validated.meetingType,
          'suggested_title': validated.suggestedTitle,
          'created_at_ms': now,
          'updated_at_ms': now,
        },
      );
      for (final item in validated.items) {
        final candidate = item.candidate;
        final insightId = await transaction
            .insert('meeting_insights', <String, Object?>{
              'note_id': noteId,
              'kind': candidate.kind.name,
              'body': candidate.body.trim(),
              'action_owner': candidate.actionOwner?.trim().isEmpty == true
                  ? null
                  : candidate.actionOwner?.trim(),
              'action_due_at_ms': candidate.actionDueAtMs,
              'unresolved_owner': item.unresolvedOwner ? 1 : 0,
              'unresolved_due_date': item.unresolvedDueDate ? 1 : 0,
              'status': MeetingInsightStatus.draft.name,
              'unsupported': item.unsupported ? 1 : 0,
              'resolution_state':
                  candidate.resolutionState ==
                          MeetingInsightResolutionState.notApplicable &&
                      (candidate.kind == MeetingInsightKind.risk ||
                          candidate.kind == MeetingInsightKind.unresolved)
                  ? MeetingInsightResolutionState.open.name
                  : candidate.resolutionState.name,
              'topic_start_ms': candidate.topicStartMs,
              'topic_end_ms': candidate.topicEndMs,
              'sort_order': candidate.sortOrder,
              'created_at_ms': now,
              'updated_at_ms': now,
            });
        for (final evidence in candidate.evidence) {
          await transaction.insert('evidence_links', <String, Object?>{
            'insight_id': insightId,
            'segment_id': evidence.segmentId,
            'start_ms': evidence.startMs,
            'end_ms': evidence.endMs,
            'created_at_ms': now,
          });
        }
      }
      if (validated.items.any((item) => !item.unsupported)) {
        await transaction.update(
          'transcript_generations',
          <String, Object?>{'has_evidence_links': 1, 'updated_at_ms': now},
          where: 'id = ?',
          whereArgs: <Object>[request.generationId],
        );
      }
      if (jobId != null) {
        final completed = await transaction.update(
          'meeting_intelligence_jobs',
          <String, Object?>{
            'status': 'completed',
            'progress': 1.0,
            'completed_at_ms': now,
            'heartbeat_at_ms': now,
            'updated_at_ms': now,
          },
          where: 'id = ? AND status = ?',
          whereArgs: <Object>[jobId, 'processing'],
        );
        if (completed != 1) {
          throw StateError('会议智能任务无法原子完成');
        }
      }
      return _loadBundle(transaction, noteId);
    });
  }

  Future<MeetingIntelligenceBundle?> findLatestForRecording(
    int recordingId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_notes',
      columns: <String>['id'],
      where: 'recording_id = ?',
      whereArgs: <Object>[recordingId],
      orderBy: 'created_at_ms DESC, id DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : _loadBundle(db, rows.single['id'] as int);
  }

  Future<MeetingIntelligenceBundle?> findByNoteId(int noteId) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_notes',
      columns: <String>['id'],
      where: 'id = ?',
      whereArgs: <Object>[noteId],
      limit: 1,
    );
    return rows.isEmpty ? null : _loadBundle(db, noteId);
  }

  Future<MeetingIntelligenceBundle?> findByJobId(int jobId) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_notes',
      columns: <String>['id'],
      where: 'job_id = ?',
      whereArgs: <Object>[jobId],
      orderBy: 'created_at_ms DESC, id DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : _loadBundle(db, rows.single['id'] as int);
  }

  Future<MeetingInsightEntity?> findInsight(int insightId) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_insights',
      where: 'id = ?',
      whereArgs: <Object>[insightId],
      limit: 1,
    );
    return rows.isEmpty ? null : MeetingInsightEntity.fromMap(rows.single);
  }

  Future<int> evidenceCount(int insightId) async {
    final db = await _database.database;
    final rows = await db.rawQuery(
      'SELECT COUNT(*) AS count FROM evidence_links WHERE insight_id = ?',
      <Object>[insightId],
    );
    return rows.single['count'] as int;
  }

  Future<void> editInsight({
    required int insightId,
    required String body,
    String? actionOwner,
    int? actionDueAtMs,
    bool clearActionOwner = false,
    bool clearActionDueAt = false,
  }) async {
    final normalized = body.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(body, 'body', '智能条目正文不能为空');
    }
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'meeting_insights',
        where: 'id = ?',
        whereArgs: <Object>[insightId],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('智能条目不存在');
      final row = rows.single;
      final previous = row['body'] as String;
      final nextOwner = clearActionOwner
          ? null
          : actionOwner?.trim().isEmpty == true
          ? null
          : actionOwner?.trim() ?? row['action_owner'] as String?;
      final nextDueAt = clearActionDueAt
          ? null
          : actionDueAtMs ?? row['action_due_at_ms'] as int?;
      if (previous == normalized &&
          row['action_owner'] == nextOwner &&
          row['action_due_at_ms'] == nextDueAt) {
        return;
      }
      final noteId = row['note_id'] as int;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('meeting_note_revisions', <String, Object?>{
        'note_id': noteId,
        'insight_id': insightId,
        'previous_body': previous,
        'next_body': normalized,
        'action': 'edit',
        'created_at_ms': now,
      });
      await transaction.update(
        'meeting_insights',
        <String, Object?>{
          'body': normalized,
          'action_owner': nextOwner,
          'action_due_at_ms': nextDueAt,
          'unresolved_owner':
              row['kind'] == MeetingInsightKind.action.name && nextOwner == null
              ? 1
              : 0,
          'unresolved_due_date':
              row['kind'] == MeetingInsightKind.action.name && nextDueAt == null
              ? 1
              : 0,
          'status': MeetingInsightStatus.draft.name,
          'reviewed_at_ms': null,
          'rejected_at_ms': null,
          'published_at_ms': null,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[insightId],
      );
      await _refreshNoteStatus(transaction, noteId, now);
    });
  }

  Future<void> updateResolutionState({
    required int insightId,
    required MeetingInsightResolutionState state,
  }) async {
    if (state == MeetingInsightResolutionState.notApplicable) {
      throw ArgumentError.value(state, 'state', '必须选择明确的解决状态');
    }
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'meeting_insights',
        where: 'id = ?',
        whereArgs: <Object>[insightId],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('会议智能条目不存在');
      final row = rows.single;
      if (row['kind'] != MeetingInsightKind.risk.name &&
          row['kind'] != MeetingInsightKind.unresolved.name) {
        throw StateError('只有风险和待确认事项可以更新解决状态');
      }
      if (row['resolution_state'] == state.name) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('meeting_note_revisions', <String, Object?>{
        'note_id': row['note_id'],
        'insight_id': insightId,
        'previous_body': row['body'],
        'next_body': row['body'],
        'action': state == MeetingInsightResolutionState.resolved
            ? 'resolve'
            : 'reopen',
        'created_at_ms': now,
      });
      await transaction.update(
        'meeting_insights',
        <String, Object?>{'resolution_state': state.name, 'updated_at_ms': now},
        where: 'id = ?',
        whereArgs: <Object>[insightId],
      );
    });
  }

  Future<void> applySuggestedTitle({
    required int noteId,
    required String title,
  }) async {
    final normalized = title.trim();
    if (normalized.isEmpty || normalized.length > 200) {
      throw ArgumentError.value(title, 'title', '会议标题长度无效');
    }
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final notes = await transaction.query(
        'meeting_notes',
        columns: <String>['recording_id', 'suggested_title'],
        where: 'id = ?',
        whereArgs: <Object>[noteId],
        limit: 1,
      );
      if (notes.isEmpty) throw StateError('会议智能记录不存在');
      if ((notes.single['suggested_title'] as String?)?.trim() != normalized) {
        throw StateError('只能应用当前纪要的标题建议');
      }
      final recordingId = notes.single['recording_id'] as int;
      final recordings = await transaction.query(
        'recordings',
        columns: <String>['display_name'],
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
        limit: 1,
      );
      if (recordings.isEmpty) throw StateError('会议不存在');
      final previous = recordings.single['display_name'] as String? ?? '';
      if (previous == normalized) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('meeting_note_revisions', <String, Object?>{
        'note_id': noteId,
        'insight_id': null,
        'previous_body': previous,
        'next_body': normalized,
        'action': 'apply_title',
        'created_at_ms': now,
      });
      await transaction.update(
        'recordings',
        <String, Object?>{'display_name': normalized},
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
    });
  }

  Future<void> updateInsightStatus({
    required int insightId,
    required MeetingInsightStatus status,
    required String action,
  }) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'meeting_insights',
        where: 'id = ?',
        whereArgs: <Object>[insightId],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('智能条目不存在');
      final row = rows.single;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.insert('meeting_note_revisions', <String, Object?>{
        'note_id': row['note_id'],
        'insight_id': insightId,
        'previous_body': row['body'],
        'next_body': row['body'],
        'action': action,
        'created_at_ms': now,
      });
      await transaction.update(
        'meeting_insights',
        <String, Object?>{
          'status': status.name,
          'reviewed_at_ms': status == MeetingInsightStatus.reviewed
              ? now
              : row['reviewed_at_ms'],
          'rejected_at_ms': status == MeetingInsightStatus.rejected
              ? now
              : null,
          'published_at_ms': status == MeetingInsightStatus.published
              ? now
              : null,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[insightId],
      );
      await _refreshNoteStatus(transaction, row['note_id'] as int, now);
    });
  }

  Future<List<MeetingNoteRevisionEntity>> listRevisions(int noteId) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_note_revisions',
      where: 'note_id = ?',
      whereArgs: <Object>[noteId],
      orderBy: 'created_at_ms DESC, id DESC',
    );
    return rows.map(MeetingNoteRevisionEntity.fromMap).toList(growable: false);
  }

  Future<MeetingIntelligenceBundle> _loadBundle(
    DatabaseExecutor executor,
    int noteId,
  ) async {
    final notes = await executor.query(
      'meeting_notes',
      where: 'id = ?',
      whereArgs: <Object>[noteId],
      limit: 1,
    );
    if (notes.isEmpty) throw StateError('会议智能记录不存在');
    final insightRows = await executor.query(
      'meeting_insights',
      where: 'note_id = ?',
      whereArgs: <Object>[noteId],
      orderBy: 'sort_order ASC, kind ASC, id ASC',
    );
    final insights = insightRows
        .map(MeetingInsightEntity.fromMap)
        .toList(growable: false);
    final evidenceByInsight = <int, List<EvidenceLinkEntity>>{};
    for (final insight in insights) {
      final evidenceRows = await executor.query(
        'evidence_links',
        where: 'insight_id = ?',
        whereArgs: <Object>[insight.id],
        orderBy: 'start_ms ASC, id ASC',
      );
      evidenceByInsight[insight.id] = evidenceRows
          .map(EvidenceLinkEntity.fromMap)
          .toList(growable: false);
    }
    return MeetingIntelligenceBundle(
      note: MeetingNoteEntity.fromMap(notes.single),
      insights: insights,
      evidenceByInsight: evidenceByInsight,
    );
  }

  Future<void> _refreshNoteStatus(
    DatabaseExecutor executor,
    int noteId,
    int now,
  ) async {
    final rows = await executor.query(
      'meeting_insights',
      columns: <String>['status'],
      where: 'note_id = ?',
      whereArgs: <Object>[noteId],
    );
    final statuses = rows.map((row) => row['status'] as String).toSet();
    final MeetingNoteStatus status;
    if (statuses.isNotEmpty &&
        statuses.every(
          (value) => value == MeetingInsightStatus.published.name,
        )) {
      status = MeetingNoteStatus.published;
    } else if (statuses.isNotEmpty &&
        statuses.every(
          (value) => value == MeetingInsightStatus.rejected.name,
        )) {
      status = MeetingNoteStatus.rejected;
    } else if (statuses.isNotEmpty &&
        statuses.every(
          (value) =>
              value == MeetingInsightStatus.reviewed.name ||
              value == MeetingInsightStatus.published.name ||
              value == MeetingInsightStatus.rejected.name,
        )) {
      status = MeetingNoteStatus.reviewed;
    } else {
      status = MeetingNoteStatus.draft;
    }
    await executor.update(
      'meeting_notes',
      <String, Object?>{
        'status': status.name,
        'reviewed_at_ms':
            status == MeetingNoteStatus.reviewed ||
                status == MeetingNoteStatus.published
            ? now
            : null,
        'published_at_ms': status == MeetingNoteStatus.published ? now : null,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[noteId],
    );
  }
}
