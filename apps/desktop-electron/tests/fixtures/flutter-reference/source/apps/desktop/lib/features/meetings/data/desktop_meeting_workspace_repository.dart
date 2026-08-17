import 'dart:convert';

import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:sqflite/sqflite.dart';

class DesktopMeetingWorkspaceRepository implements MeetingWorkspacePort {
  const DesktopMeetingWorkspaceRepository({required AppDatabase database})
    : _database = database;

  final AppDatabase _database;

  @override
  Future<List<MeetingWorkspaceSummary>> listMeetings({
    String query = '',
    int limit = 200,
    int offset = 0,
  }) async {
    final database = await _database.database;
    final normalized = query.trim();
    final rows = await database.rawQuery(
      '''
      SELECT
        r.id,
        COALESCE(r.display_name, r.source_display_name, '未命名会议') AS display_name,
        r.file_path,
        r.duration_ms,
        r.created_at_ms,
        g.id AS generation_id,
        COALESCE((
          SELECT COUNT(*)
          FROM transcript_segments AS count_segments
          WHERE count_segments.generation_id = g.id
        ), 0) AS segment_count,
        COALESCE(j.status, CASE WHEN g.id IS NULL THEN 'pending' ELSE 'completed' END)
          AS job_status,
        COALESCE(j.stage, CASE WHEN g.id IS NULL THEN 'queued' ELSE 'completed' END)
          AS job_stage
      FROM recordings AS r
      LEFT JOIN transcript_generations AS g ON g.id = r.active_generation_id
      LEFT JOIN transcription_jobs AS j ON j.id = (
        SELECT latest_job.id
        FROM transcription_jobs AS latest_job
        WHERE latest_job.recording_id = r.id
        ORDER BY latest_job.created_at_ms DESC, latest_job.id DESC
        LIMIT 1
      )
      WHERE r.deleted_at_ms IS NULL
        AND r.deletion_state = 'active'
        AND (? = '' OR COALESCE(r.display_name, r.source_display_name, '') LIKE ? ESCAPE '\\')
      ORDER BY r.created_at_ms DESC, r.id DESC
      LIMIT ? OFFSET ?
      ''',
      <Object>[normalized, '%${_escapeLike(normalized)}%', limit, offset],
    );
    return rows.map(_summaryFromRow).toList(growable: false);
  }

  @override
  Future<MeetingWorkspaceSnapshot?> openMeeting(int recordingId) async {
    final database = await _database.database;
    final summaryRows = await database.rawQuery(
      '''
      SELECT
        r.id,
        COALESCE(r.display_name, r.source_display_name, '未命名会议') AS display_name,
        r.file_path,
        r.duration_ms,
        r.created_at_ms,
        g.id AS generation_id,
        COALESCE((
          SELECT COUNT(*)
          FROM transcript_segments AS count_segments
          WHERE count_segments.generation_id = g.id
        ), 0) AS segment_count,
        COALESCE(j.status, CASE WHEN g.id IS NULL THEN 'pending' ELSE 'completed' END)
          AS job_status,
        COALESCE(j.stage, CASE WHEN g.id IS NULL THEN 'queued' ELSE 'completed' END)
          AS job_stage
      FROM recordings AS r
      LEFT JOIN transcript_generations AS g ON g.id = r.active_generation_id
      LEFT JOIN transcription_jobs AS j ON j.id = (
        SELECT latest_job.id
        FROM transcription_jobs AS latest_job
        WHERE latest_job.recording_id = r.id
        ORDER BY latest_job.created_at_ms DESC, latest_job.id DESC
        LIMIT 1
      )
      WHERE r.id = ? AND r.deleted_at_ms IS NULL
      LIMIT 1
      ''',
      <Object>[recordingId],
    );
    if (summaryRows.isEmpty) return null;
    final summary = _summaryFromRow(summaryRows.single);
    final generationId = summary.generationId;
    if (generationId == null) {
      return MeetingWorkspaceSnapshot(
        summary: summary,
        segments: const [],
        speakers: const [],
        insights: const [],
        canUndo: false,
        canRedo: false,
      );
    }
    final results = await Future.wait<Object>([
      _segments(database, generationId),
      _speakers(database, generationId),
      _insights(database, generationId),
      _hasUndo(database, generationId),
      _hasRedo(database, generationId),
    ]);
    return MeetingWorkspaceSnapshot(
      summary: summary,
      segments: results[0] as List<MeetingWorkspaceSegment>,
      speakers: results[1] as List<MeetingWorkspaceSpeaker>,
      insights: results[2] as List<MeetingWorkspaceInsight>,
      canUndo: results[3] as bool,
      canRedo: results[4] as bool,
    );
  }

  @override
  Future<List<MeetingWorkspaceSegment>> searchTranscript({
    required int recordingId,
    required String query,
    int? startMs,
    int? endMs,
    int? speakerId,
    int limit = 200,
  }) async {
    final database = await _database.database;
    final generationRows = await database.query(
      'recordings',
      columns: <String>['active_generation_id'],
      where: 'id = ?',
      whereArgs: <Object>[recordingId],
      limit: 1,
    );
    if (generationRows.isEmpty ||
        generationRows.single['active_generation_id'] == null) {
      return const [];
    }
    final generationId = generationRows.single['active_generation_id']! as int;
    return _segments(
      database,
      generationId,
      query: query,
      startMs: startMs,
      endMs: endMs,
      speakerId: speakerId,
      limit: limit,
    );
  }

  @override
  Future<bool> saveSegment({
    required int segmentId,
    required String text,
    required MeetingWorkspaceReviewState reviewState,
  }) async {
    final database = await _database.database;
    return database.transaction<bool>((transaction) async {
      final rows = await transaction.query(
        'transcript_segments',
        where: 'id = ?',
        whereArgs: <Object>[segmentId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final segment = rows.single;
      final previous = segment['text']! as String;
      final generationId = segment['generation_id']! as int;
      final recordingId = segment['recording_id']! as int;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (previous != text) {
        await transaction.update(
          'transcript_revisions',
          <String, Object?>{'invalidated_at_ms': now},
          where:
              'generation_id = ? AND reverted_at_ms IS NOT NULL '
              'AND invalidated_at_ms IS NULL',
          whereArgs: <Object>[generationId],
        );
        await transaction.insert('transcript_revisions', <String, Object?>{
          'recording_id': recordingId,
          'generation_id': generationId,
          'segment_id': segmentId,
          'previous_text': previous,
          'next_text': text,
          'created_at_ms': now,
          'reverted_at_ms': null,
          'invalidated_at_ms': null,
        });
      }
      await transaction.update(
        'transcript_segments',
        <String, Object?>{
          'text': text,
          'review_state': reviewState.storageValue,
          'reviewed_at_ms': reviewState == MeetingWorkspaceReviewState.reviewed
              ? now
              : null,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[segmentId],
      );
      await _refreshGeneration(transaction, generationId, now);
      return true;
    });
  }

  @override
  Future<bool> undo(int generationId) async {
    final database = await _database.database;
    return database.transaction<bool>((transaction) async {
      final rows = await transaction.query(
        'transcript_revisions',
        where:
            'generation_id = ? AND reverted_at_ms IS NULL '
            'AND invalidated_at_ms IS NULL',
        whereArgs: <Object>[generationId],
        orderBy: 'id DESC',
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final revision = rows.single;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.update(
        'transcript_segments',
        <String, Object?>{
          'text': revision['previous_text'],
          'updated_at_ms': now,
        },
        where: 'id = ? AND generation_id = ?',
        whereArgs: <Object>[revision['segment_id']!, generationId],
      );
      await transaction.update(
        'transcript_revisions',
        <String, Object?>{'reverted_at_ms': now},
        where: 'id = ?',
        whereArgs: <Object>[revision['id']!],
      );
      await _refreshGeneration(transaction, generationId, now);
      return true;
    });
  }

  @override
  Future<bool> redo(int generationId) async {
    final database = await _database.database;
    return database.transaction<bool>((transaction) async {
      final rows = await transaction.query(
        'transcript_revisions',
        where:
            'generation_id = ? AND reverted_at_ms IS NOT NULL '
            'AND invalidated_at_ms IS NULL',
        whereArgs: <Object>[generationId],
        orderBy: 'reverted_at_ms DESC, id DESC',
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final revision = rows.single;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.update(
        'transcript_segments',
        <String, Object?>{'text': revision['next_text'], 'updated_at_ms': now},
        where: 'id = ? AND generation_id = ?',
        whereArgs: <Object>[revision['segment_id']!, generationId],
      );
      await transaction.update(
        'transcript_revisions',
        <String, Object?>{'reverted_at_ms': null},
        where: 'id = ?',
        whereArgs: <Object>[revision['id']!],
      );
      await _refreshGeneration(transaction, generationId, now);
      return true;
    });
  }

  @override
  Future<void> renameSpeakers(Map<int, String> names) async {
    if (names.isEmpty) return;
    final database = await _database.database;
    await database.transaction<void>((transaction) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final entry in names.entries) {
        final rows = await transaction.query(
          'meeting_speakers',
          where: 'id = ? AND merged_into_speaker_id IS NULL',
          whereArgs: <Object>[entry.key],
          limit: 1,
        );
        if (rows.isEmpty) throw StateError('说话人不存在或已合并');
        final row = rows.single;
        final previous = row['display_name']! as String;
        if (previous == entry.value) continue;
        await transaction.update(
          'meeting_speakers',
          <String, Object?>{
            'display_name': entry.value,
            'source': 'manual',
            'updated_at_ms': now,
          },
          where: 'id = ?',
          whereArgs: <Object>[entry.key],
        );
        await transaction.insert('speaker_revisions', <String, Object?>{
          'recording_id': row['recording_id'],
          'generation_id': row['generation_id'],
          'action': 'rename',
          'previous_payload_json': jsonEncode({
            'speakerId': entry.key,
            'displayName': previous,
          }),
          'next_payload_json': jsonEncode({
            'speakerId': entry.key,
            'displayName': entry.value,
          }),
          'created_at_ms': now,
          'reverted_at_ms': null,
        });
      }
    });
  }

  @override
  Future<void> mergeSpeakers({
    required int generationId,
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) async {
    final database = await _database.database;
    await database.transaction<void>((transaction) async {
      final ids = <int>{targetSpeakerId, ...sourceSpeakerIds}.toList();
      final placeholders = List.filled(ids.length, '?').join(',');
      final speakers = await transaction.rawQuery(
        'SELECT id, recording_id, display_name FROM meeting_speakers '
        'WHERE generation_id = ? AND id IN ($placeholders) '
        'AND merged_into_speaker_id IS NULL',
        <Object>[generationId, ...ids],
      );
      if (speakers.length != ids.length) {
        throw StateError('说话人合并选择已过期');
      }
      final target = speakers.firstWhere(
        (speaker) => speaker['id'] == targetSpeakerId,
      );
      final now = DateTime.now().millisecondsSinceEpoch;
      final sourcePlaceholders = List.filled(
        sourceSpeakerIds.length,
        '?',
      ).join(',');
      await transaction.rawUpdate(
        'UPDATE transcript_speaker_assignments '
        "SET speaker_id = ?, source = 'manual', updated_at_ms = ? "
        'WHERE generation_id = ? AND speaker_id IN ($sourcePlaceholders)',
        <Object>[targetSpeakerId, now, generationId, ...sourceSpeakerIds],
      );
      await transaction.rawUpdate(
        'UPDATE speaker_turns '
        "SET speaker_id = ?, source = 'manual', updated_at_ms = ? "
        'WHERE generation_id = ? AND speaker_id IN ($sourcePlaceholders)',
        <Object>[targetSpeakerId, now, generationId, ...sourceSpeakerIds],
      );
      await transaction.rawUpdate(
        'UPDATE meeting_speakers '
        'SET merged_into_speaker_id = ?, updated_at_ms = ? '
        'WHERE generation_id = ? AND id IN ($sourcePlaceholders)',
        <Object>[targetSpeakerId, now, generationId, ...sourceSpeakerIds],
      );
      await transaction.insert('speaker_revisions', <String, Object?>{
        'recording_id': target['recording_id'],
        'generation_id': generationId,
        'action': 'merge',
        'previous_payload_json': jsonEncode({
          'speakerIds': sourceSpeakerIds.toList()..sort(),
        }),
        'next_payload_json': jsonEncode({
          'targetSpeakerId': targetSpeakerId,
          'displayName': target['display_name'],
        }),
        'created_at_ms': now,
        'reverted_at_ms': null,
      });
    });
  }

  @override
  Future<void> assignSpeaker({
    required int generationId,
    required int segmentId,
    required int? speakerId,
    required MeetingWorkspaceSpeakerState state,
  }) async {
    final database = await _database.database;
    await database.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'transcript_segments',
        columns: <String>[
          'recording_id',
          'generation_id',
          'start_ms',
          'end_ms',
        ],
        where: 'id = ? AND generation_id = ?',
        whereArgs: <Object>[segmentId, generationId],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('转写片段不存在');
      if (speakerId != null) {
        final speaker = await transaction.query(
          'meeting_speakers',
          columns: <String>['id'],
          where:
              'id = ? AND generation_id = ? '
              'AND merged_into_speaker_id IS NULL',
          whereArgs: <Object>[speakerId, generationId],
          limit: 1,
        );
        if (speaker.isEmpty) throw StateError('说话人不存在或已合并');
      }
      final segment = rows.single;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.delete(
        'transcript_speaker_assignments',
        where: "segment_id = ? AND source = 'manual'",
        whereArgs: <Object>[segmentId],
      );
      await transaction
          .insert('transcript_speaker_assignments', <String, Object?>{
            'recording_id': segment['recording_id'],
            'generation_id': generationId,
            'segment_id': segmentId,
            'speaker_id': speakerId,
            'start_ms': segment['start_ms'],
            'end_ms': segment['end_ms'],
            'state': state.name,
            'source': 'manual',
            'created_at_ms': now,
            'updated_at_ms': now,
          });
      await transaction.insert('speaker_revisions', <String, Object?>{
        'recording_id': segment['recording_id'],
        'generation_id': generationId,
        'action': 'assign',
        'previous_payload_json': '{}',
        'next_payload_json': jsonEncode({
          'segmentId': segmentId,
          'speakerId': speakerId,
          'state': state.name,
        }),
        'created_at_ms': now,
        'reverted_at_ms': null,
      });
    });
  }

  MeetingWorkspaceSummary _summaryFromRow(Map<String, Object?> row) {
    return MeetingWorkspaceSummary(
      recordingId: row['id']! as int,
      displayName: row['display_name']! as String,
      filePath: row['file_path']! as String,
      durationMs: row['duration_ms']! as int,
      createdAtMs: row['created_at_ms']! as int,
      generationId: row['generation_id'] as int?,
      segmentCount: (row['segment_count']! as num).toInt(),
      processingState: MeetingWorkspaceProcessingState.fromStorage(
        status: row['job_status']! as String,
        stage: row['job_stage']! as String,
      ),
    );
  }

  Future<List<MeetingWorkspaceSegment>> _segments(
    DatabaseExecutor database,
    int generationId, {
    String? query,
    int? startMs,
    int? endMs,
    int? speakerId,
    int? limit,
  }) async {
    final filters = <String>['s.generation_id = ?'];
    final arguments = <Object>[generationId];
    if (query != null) {
      filters.add("s.text LIKE ? ESCAPE '\\'");
      arguments.add('%${_escapeLike(query)}%');
    }
    if (startMs != null) {
      filters.add('s.end_ms > ?');
      arguments.add(startMs);
    }
    if (endMs != null) {
      filters.add('s.start_ms < ?');
      arguments.add(endMs);
    }
    if (speakerId != null) {
      filters.add('a.speaker_id = ?');
      arguments.add(speakerId);
    }
    if (limit != null) arguments.add(limit);
    final rows = await database.rawQuery('''
      SELECT
        s.id,
        s.sequence_id,
        s.text,
        s.start_ms,
        s.end_ms,
        s.review_state,
        a.state AS speaker_state,
        a.speaker_id,
        a.source AS speaker_source,
        p.display_name AS speaker_name
      FROM transcript_segments AS s
      LEFT JOIN transcript_speaker_assignments AS a ON a.id = (
        SELECT selected_assignment.id
        FROM transcript_speaker_assignments AS selected_assignment
        WHERE selected_assignment.segment_id = s.id
        ORDER BY
          CASE selected_assignment.source WHEN 'manual' THEN 0 ELSE 1 END,
          selected_assignment.id DESC
        LIMIT 1
      )
      LEFT JOIN meeting_speakers AS p ON p.id = a.speaker_id
      WHERE ${filters.join(' AND ')}
      ORDER BY s.sequence_id ASC, s.start_ms ASC, s.id ASC
      ${limit == null ? '' : 'LIMIT ?'}
      ''', arguments);
    return rows
        .map(
          (row) => MeetingWorkspaceSegment(
            id: row['id']! as int,
            sequenceId: row['sequence_id']! as int,
            text: row['text']! as String,
            startMs: row['start_ms']! as int,
            endMs: row['end_ms']! as int,
            reviewState: MeetingWorkspaceReviewState.fromStorage(
              row['review_state']! as String,
            ),
            speakerState: switch (row['speaker_state']) {
              'assigned' => MeetingWorkspaceSpeakerState.assigned,
              'overlap' => MeetingWorkspaceSpeakerState.overlap,
              _ => MeetingWorkspaceSpeakerState.unknown,
            },
            speakerId: row['speaker_id'] as int?,
            speakerName: row['speaker_name'] as String?,
            speakerSource: row['speaker_source'] as String?,
          ),
        )
        .toList(growable: false);
  }

  Future<List<MeetingWorkspaceSpeaker>> _speakers(
    DatabaseExecutor database,
    int generationId,
  ) async {
    final rows = await database.query(
      'meeting_speakers',
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'merged_into_speaker_id ASC, id ASC',
    );
    return rows
        .map(
          (row) => MeetingWorkspaceSpeaker(
            id: row['id']! as int,
            stableKey: row['stable_key']! as String,
            displayName: row['display_name']! as String,
            source: row['source']! as String,
            mergedIntoSpeakerId: row['merged_into_speaker_id'] as int?,
          ),
        )
        .toList(growable: false);
  }

  Future<List<MeetingWorkspaceInsight>> _insights(
    DatabaseExecutor database,
    int generationId,
  ) async {
    final rows = await database.rawQuery(
      '''
      SELECT
        i.id,
        i.kind,
        i.body,
        i.status,
        i.action_owner,
        i.action_due_at_ms
      FROM meeting_insights AS i
      INNER JOIN meeting_notes AS n ON n.id = i.note_id
      WHERE n.generation_id = ?
      ORDER BY i.sort_order ASC, i.id ASC
      ''',
      <Object>[generationId],
    );
    final output = <MeetingWorkspaceInsight>[];
    for (final row in rows) {
      final evidence = await database.query(
        'evidence_links',
        columns: <String>['segment_id'],
        where: 'insight_id = ?',
        whereArgs: <Object>[row['id']!],
        orderBy: 'start_ms ASC, id ASC',
      );
      output.add(
        MeetingWorkspaceInsight(
          id: row['id']! as int,
          kind: row['kind']! as String,
          body: row['body']! as String,
          status: row['status']! as String,
          actionOwner: row['action_owner'] as String?,
          actionDueAtMs: row['action_due_at_ms'] as int?,
          evidenceSegmentIds: evidence
              .map((item) => item['segment_id']! as int)
              .toList(growable: false),
        ),
      );
    }
    return output;
  }

  Future<bool> _hasUndo(DatabaseExecutor database, int generationId) async {
    final rows = await database.query(
      'transcript_revisions',
      columns: <String>['id'],
      where:
          'generation_id = ? AND reverted_at_ms IS NULL '
          'AND invalidated_at_ms IS NULL',
      whereArgs: <Object>[generationId],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  Future<bool> _hasRedo(DatabaseExecutor database, int generationId) async {
    final rows = await database.query(
      'transcript_revisions',
      columns: <String>['id'],
      where:
          'generation_id = ? AND reverted_at_ms IS NOT NULL '
          'AND invalidated_at_ms IS NULL',
      whereArgs: <Object>[generationId],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  Future<void> _refreshGeneration(
    DatabaseExecutor database,
    int generationId,
    int now,
  ) async {
    final segments = await database.query(
      'transcript_segments',
      columns: <String>['text'],
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
    );
    await database.update(
      'transcript_generations',
      <String, Object?>{
        'merged_text': segments
            .map((row) => (row['text']! as String).trim())
            .where((text) => text.isNotEmpty)
            .join(' '),
        'has_user_edits': 1,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[generationId],
    );
  }

  static String _escapeLike(String value) => value
      .replaceAll(r'\', r'\\')
      .replaceAll('%', r'\%')
      .replaceAll('_', r'\_');
}
