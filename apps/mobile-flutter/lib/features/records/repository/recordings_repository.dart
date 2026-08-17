import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../../../app/contracts/audio_contract.dart';
import '../../../data/sqlite/app_database.dart';
import '../model/recording_entity.dart';

class ImportedRecordingCommit {
  const ImportedRecordingCommit({
    required this.recordingId,
    required this.inserted,
    this.transcriptionJobId,
    this.existingPath,
  });

  final int recordingId;
  final bool inserted;
  final int? transcriptionJobId;
  final String? existingPath;
}

class RecordingsRepository {
  RecordingsRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<void> insert({
    required String filePath,
    required int durationMs,
  }) async {
    final db = await _database.database;
    await db.insert('recordings', {
      'file_path': filePath,
      'display_name': null,
      'group_name': null,
      'deleted_at_ms': null,
      'is_favorite': 0,
      'duration_ms': durationMs,
      'created_at_ms': DateTime.now().millisecondsSinceEpoch,
    });
  }

  Future<ImportedRecordingCommit> insertImported({
    required String filePath,
    required String displayName,
    required String fingerprintSha256,
    required int durationMs,
  }) async {
    final db = await _database.database;
    return db.transaction<ImportedRecordingCommit>((transaction) async {
      final duplicate = await transaction.query(
        'recordings',
        columns: <String>['id', 'file_path'],
        where: 'fingerprint_sha256 = ?',
        whereArgs: <Object>[fingerprintSha256],
        limit: 1,
      );
      if (duplicate.isNotEmpty) {
        return ImportedRecordingCommit(
          recordingId: duplicate.single['id'] as int,
          inserted: false,
          existingPath: duplicate.single['file_path'] as String,
        );
      }
      final id = await transaction.insert('recordings', <String, Object?>{
        'file_path': filePath,
        'display_name': displayName,
        'group_name': null,
        'deleted_at_ms': null,
        'is_favorite': 0,
        'session_id': null,
        'asset_kind': 'imported',
        'fingerprint_sha256': fingerprintSha256,
        'source_display_name': displayName,
        'deletion_state': 'active',
        'duration_ms': durationMs,
        'created_at_ms': DateTime.now().millisecondsSinceEpoch,
      });
      final now = DateTime.now().millisecondsSinceEpoch;
      final dedupeKey = '$filePath|import_offline';
      final jobId = await transaction
          .insert('transcription_jobs', <String, Object?>{
            'recording_path': filePath,
            'duration_ms': durationMs,
            'status': 'pending',
            'recording_mode': 'standard',
            'source': 'import_offline',
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
            'recording_id': id,
            'generation_id': null,
            'created_at_ms': now,
            'updated_at_ms': now,
            'result_text': null,
            'error_message': null,
          });
      return ImportedRecordingCommit(
        recordingId: id,
        inserted: true,
        transcriptionJobId: jobId,
      );
    });
  }

  Future<List<RecordingEntity>> listActive({String? groupName}) async {
    final db = await _database.database;
    final String normalizedGroupName = groupName?.trim() ?? '';
    final List<Map<String, Object?>> rows;
    if (normalizedGroupName.isEmpty || normalizedGroupName == 'all') {
      rows = await db.query(
        'recordings',
        where: 'deleted_at_ms IS NULL',
        orderBy: 'created_at_ms DESC, id DESC',
        limit: 200,
      );
    } else {
      rows = await db.query(
        'recordings',
        where: 'deleted_at_ms IS NULL AND group_name = ?',
        whereArgs: <Object>[normalizedGroupName],
        orderBy: 'created_at_ms DESC, id DESC',
        limit: 200,
      );
    }
    return rows.map(RecordingEntity.fromMap).toList();
  }

  Future<List<RecordingEntity>> listDeleted() async {
    final db = await _database.database;
    final rows = await db.query(
      'recordings',
      where: 'deleted_at_ms IS NOT NULL',
      orderBy: 'deleted_at_ms DESC, id DESC',
      limit: 200,
    );
    return rows.map(RecordingEntity.fromMap).toList();
  }

  Future<List<RecordingEntity>> listDeletedAtOrBefore({
    required int deletedAtOrBeforeMs,
    required int limit,
  }) async {
    if (limit <= 0) {
      throw ArgumentError.value(limit, 'limit', 'must be positive');
    }
    final db = await _database.database;
    final rows = await db.query(
      'recordings',
      where: 'deleted_at_ms IS NOT NULL AND deleted_at_ms <= ?',
      whereArgs: <Object>[deletedAtOrBeforeMs],
      orderBy: 'deleted_at_ms ASC, id ASC',
      limit: limit,
    );
    return rows.map(RecordingEntity.fromMap).toList(growable: false);
  }

  Future<void> deleteById(int id) async {
    final db = await _database.database;
    await db.delete('recordings', where: 'id = ?', whereArgs: <Object>[id]);
  }

  Future<RecordingEntity?> findById(int id) async {
    final db = await _database.database;
    final rows = await db.query(
      'recordings',
      where: 'id = ?',
      whereArgs: <Object>[id],
      limit: 1,
    );
    return rows.isEmpty ? null : RecordingEntity.fromMap(rows.single);
  }

  Future<Map<int, RecordingEntity>> findByIds(Iterable<int> ids) async {
    final uniqueIds = ids.toSet().toList(growable: false);
    if (uniqueIds.isEmpty) return const <int, RecordingEntity>{};
    final db = await _database.database;
    final recordings = <int, RecordingEntity>{};
    for (var offset = 0; offset < uniqueIds.length; offset += 500) {
      final end = offset + 500 < uniqueIds.length
          ? offset + 500
          : uniqueIds.length;
      final batch = uniqueIds.sublist(offset, end);
      final placeholders = List<String>.filled(batch.length, '?').join(', ');
      final rows = await db.query(
        'recordings',
        where: 'id IN ($placeholders)',
        whereArgs: batch.cast<Object>(),
      );
      for (final row in rows) {
        final recording = RecordingEntity.fromMap(row);
        recordings[recording.id] = recording;
      }
    }
    return recordings;
  }

  Future<RecordingEntity?> findByFingerprint(String fingerprintSha256) async {
    final db = await _database.database;
    final rows = await db.query(
      'recordings',
      where: 'fingerprint_sha256 = ?',
      whereArgs: <Object>[fingerprintSha256],
      limit: 1,
    );
    return rows.isEmpty ? null : RecordingEntity.fromMap(rows.single);
  }

  Future<void> markDeletionPending(int id) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'deletion_state': 'pending'},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<List<String>> listOwnedAssetPaths(int recordingId) async {
    final db = await _database.database;
    final recordingRows = await db.query(
      'recordings',
      columns: <String>['file_path', 'session_id'],
      where: 'id = ?',
      whereArgs: <Object>[recordingId],
      limit: 1,
    );
    if (recordingRows.isEmpty) return const <String>[];
    final recording = recordingRows.single;
    final recordingPath = recording['file_path'] as String;
    final assets = await db.query(
      'audio_assets',
      columns: <String>['path'],
      where: 'recording_id = ?',
      whereArgs: <Object>[recordingId],
    );
    final sessions = await db.query(
      'recording_sessions',
      columns: <String>['session_id', 'staging_path', 'canonical_path'],
      where: 'recording_id = ?',
      whereArgs: <Object>[recordingId],
    );
    final paths = <String>{
      recordingPath,
      ...assets.map((row) => row['path'] as String),
    };
    final sessionIds = <String>{};
    final recordingSessionId = recording['session_id'] as String?;
    if (recordingSessionId?.isNotEmpty == true) {
      sessionIds.add(recordingSessionId!);
    }
    for (final session in sessions) {
      final sessionId = session['session_id'] as String?;
      if (sessionId?.isNotEmpty == true) sessionIds.add(sessionId!);
      for (final column in const <String>['staging_path', 'canonical_path']) {
        final path = session[column] as String?;
        if (path?.isNotEmpty == true) paths.add(path!);
      }
    }
    final audioRoot = _managedAudioRoot(recordingPath);
    if (audioRoot != null) {
      for (final sessionId in sessionIds) {
        paths.add(
          p.join(
            audioRoot,
            AudioContract.recordingJournalDirName,
            '$sessionId${AudioContract.recordingJournalSuffix}',
          ),
        );
      }
    }
    return paths.toList(growable: false);
  }

  Future<void> registerOwnedAsset({
    required int recordingId,
    required String path,
    required String kind,
  }) async {
    final db = await _database.database;
    await db.insert('audio_assets', <String, Object?>{
      'recording_id': recordingId,
      'path': path,
      'kind': kind,
      'created_at_ms': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  Future<void> deleteAudioGraph({
    required int recordingId,
    required String recordingPath,
  }) async {
    final db = await _database.database;
    await db.transaction<void>((transaction) async {
      await transaction.delete(
        'transcript_segments',
        where: 'recording_path = ?',
        whereArgs: <Object>[recordingPath],
      );
      await transaction.delete(
        'transcription_jobs',
        where: 'recording_path = ?',
        whereArgs: <Object>[recordingPath],
      );
      await transaction.delete(
        'transcript_generations',
        where: 'recording_id = ?',
        whereArgs: <Object>[recordingId],
      );
      await transaction.delete(
        'recording_sessions',
        where: 'recording_id = ?',
        whereArgs: <Object>[recordingId],
      );
      await transaction.delete(
        'audio_assets',
        where: 'recording_id = ?',
        whereArgs: <Object>[recordingId],
      );
      await transaction.delete(
        'recordings',
        where: 'id = ?',
        whereArgs: <Object>[recordingId],
      );
    });
  }

  Future<void> updateDisplayName({
    required int id,
    required String? displayName,
  }) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'display_name': displayName},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<void> softDeleteById(int id) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'deleted_at_ms': DateTime.now().millisecondsSinceEpoch},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<void> restoreById(int id) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'deleted_at_ms': null, 'deletion_state': 'active'},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<void> updateFavorite({
    required int id,
    required bool isFavorite,
  }) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'is_favorite': isFavorite ? 1 : 0},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<void> updateGroupName({
    required int id,
    required String? groupName,
  }) async {
    final db = await _database.database;
    await db.update(
      'recordings',
      <String, Object?>{'group_name': groupName?.trim()},
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }
}

String? _managedAudioRoot(String filePath) {
  final normalized = p.normalize(filePath);
  final marker =
      '${p.separator}files${p.separator}'
      '${AudioContract.audioDirName}${p.separator}';
  final markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return null;
  return normalized.substring(0, markerIndex + marker.length - 1);
}
