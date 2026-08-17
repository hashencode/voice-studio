import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../model/recording_annotation_entity.dart';

class RecordingAnnotationsRepository {
  RecordingAnnotationsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<List<RecordingAnnotationEntity>> listForSession(
    String sessionId,
  ) async {
    final db = await _database.database;
    final rows = await db.query(
      'recording_annotations',
      where: 'session_id = ?',
      whereArgs: <Object>[sessionId],
      orderBy: 'position_ms ASC, id ASC',
    );
    return rows.map(RecordingAnnotationEntity.fromMap).toList(growable: false);
  }

  Future<List<RecordingAnnotationEntity>> listForRecording(
    int recordingId,
  ) async {
    final db = await _database.database;
    final rows = await db.rawQuery(
      '''
      SELECT annotation.*
      FROM recording_annotations AS annotation
      JOIN recording_sessions AS session
        ON session.session_id = annotation.session_id
      WHERE session.recording_id = ?
      ORDER BY annotation.position_ms ASC, annotation.id ASC
      ''',
      <Object>[recordingId],
    );
    return rows.map(RecordingAnnotationEntity.fromMap).toList(growable: false);
  }

  Future<RecordingAnnotationEntity> addMarker({
    required String sessionId,
    required int positionMs,
  }) async {
    _validatePosition(positionMs);
    final db = await _database.database;
    await _requireSession(db, sessionId);
    final now = DateTime.now().millisecondsSinceEpoch;
    final id = await db.insert('recording_annotations', <String, Object?>{
      'session_id': sessionId,
      'kind': RecordingAnnotationKind.marker.storageValue,
      'position_ms': positionMs,
      'text': null,
      'created_at_ms': now,
      'updated_at_ms': now,
    });
    return RecordingAnnotationEntity(
      id: id,
      sessionId: sessionId,
      kind: RecordingAnnotationKind.marker,
      positionMs: positionMs,
      createdAtMs: now,
      updatedAtMs: now,
    );
  }

  Future<RecordingAnnotationEntity?> saveNote({
    required String sessionId,
    required int positionMs,
    required String text,
  }) async {
    _validatePosition(positionMs);
    final db = await _database.database;
    return db.transaction<RecordingAnnotationEntity?>((transaction) async {
      await _requireSession(transaction, sessionId);
      final normalized = text.trim();
      final existing = await transaction.query(
        'recording_annotations',
        where: 'session_id = ? AND kind = ?',
        whereArgs: <Object>[
          sessionId,
          RecordingAnnotationKind.note.storageValue,
        ],
        limit: 1,
      );
      if (normalized.isEmpty) {
        if (existing.isNotEmpty) {
          await transaction.delete(
            'recording_annotations',
            where: 'id = ?',
            whereArgs: <Object>[existing.single['id'] as int],
          );
        }
        return null;
      }

      final now = DateTime.now().millisecondsSinceEpoch;
      if (existing.isNotEmpty) {
        final row = existing.single;
        await transaction.update(
          'recording_annotations',
          <String, Object?>{'text': normalized, 'updated_at_ms': now},
          where: 'id = ?',
          whereArgs: <Object>[row['id'] as int],
        );
        return RecordingAnnotationEntity(
          id: row['id'] as int,
          sessionId: sessionId,
          kind: RecordingAnnotationKind.note,
          positionMs: row['position_ms'] as int,
          text: normalized,
          createdAtMs: row['created_at_ms'] as int,
          updatedAtMs: now,
        );
      }

      final id = await transaction
          .insert('recording_annotations', <String, Object?>{
            'session_id': sessionId,
            'kind': RecordingAnnotationKind.note.storageValue,
            'position_ms': positionMs,
            'text': normalized,
            'created_at_ms': now,
            'updated_at_ms': now,
          });
      return RecordingAnnotationEntity(
        id: id,
        sessionId: sessionId,
        kind: RecordingAnnotationKind.note,
        positionMs: positionMs,
        text: normalized,
        createdAtMs: now,
        updatedAtMs: now,
      );
    });
  }

  static void _validatePosition(int positionMs) {
    if (positionMs < 0) {
      throw ArgumentError.value(positionMs, 'positionMs', '不能小于 0');
    }
  }

  static Future<void> _requireSession(
    DatabaseExecutor database,
    String sessionId,
  ) async {
    if (sessionId.trim().isEmpty) {
      throw StateError('录音注释缺少 sessionId');
    }
    final rows = await database.query(
      'recording_sessions',
      columns: <String>['session_id'],
      where: 'session_id = ?',
      whereArgs: <Object>[sessionId],
      limit: 1,
    );
    if (rows.isEmpty) {
      throw StateError('录音会话不存在，无法保存注释');
    }
  }
}
