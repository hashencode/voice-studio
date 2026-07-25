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
  }) async {
    final db = await _database.database;
    return db.transaction<MeetingIntelligenceBundle>((transaction) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final noteId = await transaction.insert(
        'meeting_notes',
        <String, Object?>{
          'recording_id': request.recordingId,
          'generation_id': request.generationId,
          'status': MeetingNoteStatus.draft.name,
          'provider_id': provider.providerId,
          'model_id': provider.modelId,
          'processing_location': request.processingLocation.name,
          'consent_granted':
              request.consentDecision == MeetingConsentDecision.granted ? 1 : 0,
          'input_start_ms': request.inputStartMs,
          'input_end_ms': request.inputEndMs,
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
      if (previous == normalized) return;
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
      orderBy: 'kind ASC, id ASC',
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
