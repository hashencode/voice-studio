import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/meeting_speaker_entity.dart';
import '../model/speaker_turn_entity.dart';

class SpeakerTurnDraft {
  const SpeakerTurnDraft({
    required this.stableSpeakerKey,
    required this.startMs,
    required this.endMs,
    this.confidence,
  });

  final String stableSpeakerKey;
  final int startMs;
  final int endMs;
  final double? confidence;
}

class SpeakerAssignmentDraft {
  const SpeakerAssignmentDraft({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
    required this.state,
    this.stableSpeakerKey,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
  final SpeakerAssignmentState state;
  final String? stableSpeakerKey;
}

class SpeakerRepository {
  SpeakerRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<void> replaceAutomaticResult({
    required int recordingId,
    required int generationId,
    required List<SpeakerTurnDraft> turns,
    required List<SpeakerAssignmentDraft> assignments,
  }) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
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
      final keys = <String>{
        ...turns.map((turn) => turn.stableSpeakerKey),
        ...assignments
            .map((assignment) => assignment.stableSpeakerKey)
            .whereType<String>(),
      }.toList(growable: false)..sort();
      final now = DateTime.now().millisecondsSinceEpoch;
      final speakerIds = <String, int>{};
      for (var index = 0; index < keys.length; index++) {
        final key = keys[index];
        await transaction.insert('meeting_speakers', <String, Object?>{
          'recording_id': recordingId,
          'generation_id': generationId,
          'stable_key': key,
          'display_name': '说话人 ${index + 1}',
          'source': 'automatic',
          'created_at_ms': now,
          'updated_at_ms': now,
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
        final rows = await transaction.query(
          'meeting_speakers',
          columns: <String>['id'],
          where: 'generation_id = ? AND stable_key = ?',
          whereArgs: <Object>[generationId, key],
          limit: 1,
        );
        speakerIds[key] = rows.single['id'] as int;
      }
      for (final turn in turns) {
        _requireRange(turn.startMs, turn.endMs);
        await transaction.insert('speaker_turns', <String, Object?>{
          'recording_id': recordingId,
          'generation_id': generationId,
          'speaker_id': speakerIds[turn.stableSpeakerKey],
          'start_ms': turn.startMs,
          'end_ms': turn.endMs,
          'source': 'automatic',
          'confidence': turn.confidence,
          'created_at_ms': now,
          'updated_at_ms': now,
        });
      }
      for (final assignment in assignments) {
        _requireRange(assignment.startMs, assignment.endMs);
        if (assignment.state == SpeakerAssignmentState.assigned &&
            assignment.stableSpeakerKey == null) {
          throw ArgumentError(
            'assigned speaker assignment requires a speaker key',
          );
        }
        await transaction
            .insert('transcript_speaker_assignments', <String, Object?>{
              'recording_id': recordingId,
              'generation_id': generationId,
              'segment_id': assignment.segmentId,
              'speaker_id': assignment.stableSpeakerKey == null
                  ? null
                  : speakerIds[assignment.stableSpeakerKey],
              'start_ms': assignment.startMs,
              'end_ms': assignment.endMs,
              'state': assignment.state.name,
              'source': 'automatic',
              'created_at_ms': now,
              'updated_at_ms': now,
            });
      }
    });
  }

  Future<List<MeetingSpeakerEntity>> listSpeakers(int generationId) async {
    final db = await _database.database;
    final rows = await db.query(
      'meeting_speakers',
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'id ASC',
    );
    return rows.map(MeetingSpeakerEntity.fromMap).toList(growable: false);
  }

  Future<List<SpeakerTurnEntity>> listTurns(int generationId) async {
    final db = await _database.database;
    final rows = await db.query(
      'speaker_turns',
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'start_ms ASC, end_ms ASC, id ASC',
    );
    return rows.map(SpeakerTurnEntity.fromMap).toList(growable: false);
  }

  Future<List<TranscriptSpeakerAssignmentEntity>> listAssignments(
    int generationId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'transcript_speaker_assignments',
      where: 'generation_id = ?',
      whereArgs: <Object>[generationId],
      orderBy: 'start_ms ASC, end_ms ASC, id ASC',
    );
    return rows
        .map(TranscriptSpeakerAssignmentEntity.fromMap)
        .toList(growable: false);
  }

  Future<void> renameSpeaker({
    required int speakerId,
    required String displayName,
  }) async {
    final normalized = displayName.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(
        displayName,
        'displayName',
        'must not be empty',
      );
    }
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      final rows = await transaction.query(
        'meeting_speakers',
        where: 'id = ?',
        whereArgs: <Object>[speakerId],
        limit: 1,
      );
      if (rows.isEmpty) throw StateError('说话人不存在');
      final row = rows.single;
      final previous = row['display_name'] as String;
      if (previous == normalized) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      await transaction.update(
        'meeting_speakers',
        <String, Object?>{
          'display_name': normalized,
          'source': 'manual',
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[speakerId],
      );
      await transaction.insert('speaker_revisions', <String, Object?>{
        'recording_id': row['recording_id'],
        'generation_id': row['generation_id'],
        'action': 'rename',
        'previous_payload_json': jsonEncode(<String, Object?>{
          'speakerId': speakerId,
          'displayName': previous,
        }),
        'next_payload_json': jsonEncode(<String, Object?>{
          'speakerId': speakerId,
          'displayName': normalized,
        }),
        'created_at_ms': now,
      });
    });
  }

  static void _requireRange(int startMs, int endMs) {
    if (startMs < 0 || endMs <= startMs) {
      throw ArgumentError('speaker range must be non-empty and non-negative');
    }
  }
}
