import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../app_database.dart';

class DesktopCaptureSessionRecord {
  const DesktopCaptureSessionRecord({
    required this.sessionId,
    required this.state,
    required this.workspacePath,
    required this.captureTimelineMs,
    required this.partialCapture,
    required this.createdAtMs,
    required this.updatedAtMs,
    this.recordingId,
    this.recordingSha256,
    this.recoveryDisposition,
  });

  factory DesktopCaptureSessionRecord.fromRow(Map<String, Object?> row) {
    return DesktopCaptureSessionRecord(
      sessionId: row['session_id']! as String,
      state: row['state']! as String,
      workspacePath: row['workspace_path']! as String,
      captureTimelineMs: row['capture_timeline_ms']! as int,
      partialCapture: row['partial_capture'] == 1,
      recordingId: row['recording_id'] as int?,
      recordingSha256: row['recording_sha256'] as String?,
      recoveryDisposition: row['recovery_disposition'] as String?,
      createdAtMs: row['created_at_ms']! as int,
      updatedAtMs: row['updated_at_ms']! as int,
    );
  }

  final String sessionId;
  final String state;
  final String workspacePath;
  final int captureTimelineMs;
  final bool partialCapture;
  final int? recordingId;
  final String? recordingSha256;
  final String? recoveryDisposition;
  final int createdAtMs;
  final int updatedAtMs;
}

class DesktopCaptureTrackRecord {
  const DesktopCaptureTrackRecord({
    required this.sessionId,
    required this.kind,
    required this.healthy,
    required this.sampleRate,
    required this.channels,
    required this.format,
  });

  final String sessionId;
  final String kind;
  final bool healthy;
  final double sampleRate;
  final int channels;
  final String format;
}

class DesktopCaptureChunkRecord {
  const DesktopCaptureChunkRecord({
    required this.sessionId,
    required this.trackKind,
    required this.sequence,
    required this.startMs,
    required this.endMs,
    required this.relativePath,
    required this.bytes,
    required this.sha256,
    required this.createdAtMs,
  });

  final String sessionId;
  final String trackKind;
  final int sequence;
  final int startMs;
  final int endMs;
  final String relativePath;
  final int bytes;
  final String sha256;
  final int createdAtMs;
}

class DesktopCaptureEventRecord {
  const DesktopCaptureEventRecord({
    required this.sessionId,
    required this.sequence,
    required this.monotonicMs,
    required this.kind,
    required this.trackKind,
    required this.reason,
    required this.createdAtMs,
  });

  final String sessionId;
  final int sequence;
  final int monotonicMs;
  final String kind;
  final String trackKind;
  final String reason;
  final int createdAtMs;
}

class DesktopCaptureCommandReceipt {
  const DesktopCaptureCommandReceipt({
    required this.sessionId,
    required this.idempotencyKey,
    required this.action,
    required this.result,
    required this.createdAtMs,
  });

  final String sessionId;
  final String idempotencyKey;
  final String action;
  final Map<String, Object?> result;
  final int createdAtMs;
}

class DesktopCaptureRepository {
  DesktopCaptureRepository(this._owner);

  final AppDatabase _owner;

  Future<DesktopCaptureSessionRecord> beginSession({
    required String sessionId,
    required String workspacePath,
    required int nowMs,
  }) async {
    final database = await _owner.database;
    return database.transaction((transaction) async {
      final existing = await _findSession(transaction, sessionId);
      if (existing != null) {
        if (existing.workspacePath != workspacePath) {
          throw StateError(
            'Capture session $sessionId cannot change workspace path',
          );
        }
        return existing;
      }
      await transaction.insert('desktop_capture_sessions', <String, Object?>{
        'session_id': sessionId,
        'state': 'preparing',
        'workspace_path': workspacePath,
        'capture_timeline_ms': 0,
        'partial_capture': 0,
        'created_at_ms': nowMs,
        'updated_at_ms': nowMs,
      });
      return (await _findSession(transaction, sessionId))!;
    });
  }

  Future<DesktopCaptureSessionRecord?> findSession(String sessionId) async {
    return _findSession(await _owner.database, sessionId);
  }

  Future<List<DesktopCaptureSessionRecord>> recoverableSessions() async {
    final database = await _owner.database;
    final rows = await database.query(
      'desktop_capture_sessions',
      where:
          "state IN ('preparing', 'recording', 'paused', 'finalizing', "
          "'recoverable', 'partial_capture') "
          'AND recording_id IS NULL AND recovery_disposition IS NULL',
      orderBy: 'updated_at_ms ASC, session_id ASC',
    );
    return rows
        .map(DesktopCaptureSessionRecord.fromRow)
        .toList(growable: false);
  }

  Future<void> upsertTrack(DesktopCaptureTrackRecord track) async {
    final database = await _owner.database;
    await database.insert('desktop_capture_tracks', <String, Object?>{
      'session_id': track.sessionId,
      'kind': track.kind,
      'healthy': track.healthy ? 1 : 0,
      'sample_rate': track.sampleRate,
      'channels': track.channels,
      'format': track.format,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> recordChunk(DesktopCaptureChunkRecord chunk) async {
    final database = await _owner.database;
    await database.transaction((transaction) async {
      final values = <String, Object?>{
        'session_id': chunk.sessionId,
        'track_kind': chunk.trackKind,
        'sequence': chunk.sequence,
        'start_ms': chunk.startMs,
        'end_ms': chunk.endMs,
        'relative_path': chunk.relativePath,
        'bytes': chunk.bytes,
        'sha256': chunk.sha256,
        'finalized': 1,
        'created_at_ms': chunk.createdAtMs,
      };
      final inserted = await transaction.insert(
        'desktop_capture_chunks',
        values,
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      if (inserted != 0) {
        return;
      }
      final rows = await transaction.query(
        'desktop_capture_chunks',
        where: 'session_id = ? AND track_kind = ? AND sequence = ?',
        whereArgs: <Object?>[chunk.sessionId, chunk.trackKind, chunk.sequence],
        limit: 1,
      );
      if (rows.length != 1 || !_sameColumns(rows.single, values)) {
        throw StateError(
          'Capture chunk identity drifted for '
          '${chunk.sessionId}/${chunk.trackKind}/${chunk.sequence}',
        );
      }
    });
  }

  Future<void> recordEvent(DesktopCaptureEventRecord event) async {
    final database = await _owner.database;
    await database.transaction((transaction) async {
      final values = <String, Object?>{
        'session_id': event.sessionId,
        'sequence': event.sequence,
        'monotonic_ms': event.monotonicMs,
        'kind': event.kind,
        'track_kind': event.trackKind,
        'reason': event.reason,
        'created_at_ms': event.createdAtMs,
      };
      final inserted = await transaction.insert(
        'desktop_capture_events',
        values,
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      if (inserted != 0) {
        return;
      }
      final rows = await transaction.query(
        'desktop_capture_events',
        where: 'session_id = ? AND sequence = ?',
        whereArgs: <Object?>[event.sessionId, event.sequence],
        limit: 1,
      );
      if (rows.length != 1 || !_sameColumns(rows.single, values)) {
        throw StateError(
          'Capture event identity drifted for '
          '${event.sessionId}/${event.sequence}',
        );
      }
    });
  }

  Future<DesktopCaptureCommandReceipt?> commandReceipt({
    required String sessionId,
    required String idempotencyKey,
  }) async {
    final database = await _owner.database;
    final rows = await database.query(
      'desktop_capture_command_receipts',
      where: 'session_id = ? AND idempotency_key = ?',
      whereArgs: <Object?>[sessionId, idempotencyKey],
      limit: 1,
    );
    if (rows.isEmpty) {
      return null;
    }
    return _receiptFromRow(rows.single);
  }

  Future<DesktopCaptureCommandReceipt> commitCaptureManifest({
    required String sessionId,
    required String manifestPath,
    required String displayName,
    required int durationMs,
    required String recordingSha256,
    required bool partialCapture,
    required String idempotencyKey,
    required Map<String, Object?> nativeResult,
    required int nowMs,
  }) async {
    final database = await _owner.database;
    return database.transaction((transaction) async {
      final existingReceipt = await transaction.query(
        'desktop_capture_command_receipts',
        where: 'session_id = ? AND idempotency_key = ?',
        whereArgs: <Object?>[sessionId, idempotencyKey],
        limit: 1,
      );
      if (existingReceipt.isNotEmpty) {
        final receipt = _receiptFromRow(existingReceipt.single);
        if (receipt.action != 'stop') {
          throw StateError(
            'Capture idempotency key was reused with different intent',
          );
        }
        return receipt;
      }
      final current = await _findSession(transaction, sessionId);
      if (current == null) {
        throw StateError('Unknown capture session: $sessionId');
      }
      final recordings = await transaction.query(
        'recordings',
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
        limit: 1,
      );
      late final int recordingId;
      if (recordings.isEmpty) {
        recordingId = await transaction.insert('recordings', <String, Object?>{
          'file_path': manifestPath,
          'display_name': displayName,
          'session_id': sessionId,
          'asset_kind': 'desktop_capture_manifest',
          'fingerprint_sha256': recordingSha256,
          'source_display_name': displayName,
          'duration_ms': durationMs,
          'created_at_ms': nowMs,
        });
      } else {
        final row = recordings.single;
        if (row['file_path'] != manifestPath ||
            row['fingerprint_sha256'] != recordingSha256) {
          throw StateError('Capture session recording commit drifted');
        }
        recordingId = row['id']! as int;
      }
      await transaction.insert('meeting_assets', <String, Object?>{
        'recording_id': recordingId,
        'path': manifestPath,
        'kind': 'capture_manifest',
        'created_at_ms': nowMs,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      final chunks = await transaction.query(
        'desktop_capture_chunks',
        columns: <String>['track_kind', 'relative_path'],
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
        orderBy: 'track_kind ASC, sequence ASC',
      );
      final workspace = current.workspacePath;
      for (final chunk in chunks) {
        final separator = workspace.endsWith('/') ? '' : '/';
        await transaction.insert('meeting_assets', <String, Object?>{
          'recording_id': recordingId,
          'path': '$workspace$separator${chunk['relative_path']}',
          'kind': 'capture_${chunk['track_kind']}',
          'created_at_ms': nowMs,
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
      }
      final state = partialCapture ? 'partial_capture' : 'completed';
      await transaction.update(
        'desktop_capture_sessions',
        <String, Object?>{
          'state': state,
          'capture_timeline_ms': durationMs,
          'partial_capture': partialCapture ? 1 : 0,
          'recording_id': recordingId,
          'recording_sha256': recordingSha256,
          'updated_at_ms': nowMs,
        },
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
      );
      final result = <String, Object?>{
        ...nativeResult,
        'state': state,
        'recordingId': recordingId.toString(),
        'recordingSha256': recordingSha256,
      };
      final resultJson = jsonEncode(result);
      await transaction
          .insert('desktop_capture_command_receipts', <String, Object?>{
            'session_id': sessionId,
            'idempotency_key': idempotencyKey,
            'action': 'stop',
            'result_json': resultJson,
            'created_at_ms': nowMs,
          });
      return DesktopCaptureCommandReceipt(
        sessionId: sessionId,
        idempotencyKey: idempotencyKey,
        action: 'stop',
        result: result,
        createdAtMs: nowMs,
      );
    });
  }

  Future<void> saveSnapshotAndReceipt({
    required String sessionId,
    required String state,
    required int captureTimelineMs,
    required bool partialCapture,
    required String action,
    required String idempotencyKey,
    required Map<String, Object?> result,
    required int nowMs,
  }) async {
    final database = await _owner.database;
    await database.transaction((transaction) async {
      final current = await _findSession(transaction, sessionId);
      if (current == null) {
        throw StateError('Unknown capture session: $sessionId');
      }
      if (captureTimelineMs < current.captureTimelineMs) {
        throw StateError('Capture timeline cannot move backwards');
      }
      if (!_validTransition(current.state, state)) {
        throw StateError(
          'Illegal durable capture transition: ${current.state} -> $state',
        );
      }
      await transaction.update(
        'desktop_capture_sessions',
        <String, Object?>{
          'state': state,
          'capture_timeline_ms': captureTimelineMs,
          'partial_capture': partialCapture ? 1 : 0,
          'updated_at_ms': nowMs,
        },
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
      );
      final resultJson = jsonEncode(result);
      final inserted = await transaction.insert(
        'desktop_capture_command_receipts',
        <String, Object?>{
          'session_id': sessionId,
          'idempotency_key': idempotencyKey,
          'action': action,
          'result_json': resultJson,
          'created_at_ms': nowMs,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      if (inserted == 0) {
        final rows = await transaction.query(
          'desktop_capture_command_receipts',
          where: 'session_id = ? AND idempotency_key = ?',
          whereArgs: <Object?>[sessionId, idempotencyKey],
          limit: 1,
        );
        final row = rows.single;
        if (row['action'] != action || row['result_json'] != resultJson) {
          throw StateError(
            'Capture idempotency key was reused with different intent',
          );
        }
      }
    });
  }

  Future<void> commitRecording({
    required String sessionId,
    required int recordingId,
    required String recordingSha256,
    required bool partialCapture,
    required String idempotencyKey,
    required Map<String, Object?> result,
    required int nowMs,
  }) async {
    final database = await _owner.database;
    await database.transaction((transaction) async {
      final current = await _findSession(transaction, sessionId);
      if (current == null) {
        throw StateError('Unknown capture session: $sessionId');
      }
      if (current.recordingId != null &&
          (current.recordingId != recordingId ||
              current.recordingSha256 != recordingSha256)) {
        throw StateError('Capture session recording commit drifted');
      }
      await transaction.update(
        'desktop_capture_sessions',
        <String, Object?>{
          'state': partialCapture ? 'partial_capture' : 'completed',
          'partial_capture': partialCapture ? 1 : 0,
          'recording_id': recordingId,
          'recording_sha256': recordingSha256,
          'updated_at_ms': nowMs,
        },
        where: 'session_id = ?',
        whereArgs: <Object?>[sessionId],
      );
      final resultJson = jsonEncode(result);
      final inserted = await transaction.insert(
        'desktop_capture_command_receipts',
        <String, Object?>{
          'session_id': sessionId,
          'idempotency_key': idempotencyKey,
          'action': 'stop',
          'result_json': resultJson,
          'created_at_ms': nowMs,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      if (inserted == 0) {
        final rows = await transaction.query(
          'desktop_capture_command_receipts',
          where: 'session_id = ? AND idempotency_key = ?',
          whereArgs: <Object?>[sessionId, idempotencyKey],
          limit: 1,
        );
        if (rows.single['action'] != 'stop' ||
            rows.single['result_json'] != resultJson) {
          throw StateError(
            'Capture stop idempotency key was reused with different intent',
          );
        }
      }
    });
  }

  Future<void> setRecoveryDisposition({
    required String sessionId,
    required String disposition,
    required int nowMs,
  }) async {
    if (!const <String>{
      'completed_recovery',
      'kept_partial',
      'discarded',
    }.contains(disposition)) {
      throw const FormatException('Invalid capture recovery disposition');
    }
    final database = await _owner.database;
    final changed = await database.update(
      'desktop_capture_sessions',
      <String, Object?>{
        'recovery_disposition': disposition,
        'state': disposition == 'discarded' ? 'failed' : null,
        'updated_at_ms': nowMs,
      }..removeWhere((key, value) => value == null),
      where: 'session_id = ?',
      whereArgs: <Object?>[sessionId],
    );
    if (changed != 1) throw StateError('Unknown capture recovery session');
  }

  static Future<DesktopCaptureSessionRecord?> _findSession(
    DatabaseExecutor database,
    String sessionId,
  ) async {
    final rows = await database.query(
      'desktop_capture_sessions',
      where: 'session_id = ?',
      whereArgs: <Object?>[sessionId],
      limit: 1,
    );
    return rows.isEmpty
        ? null
        : DesktopCaptureSessionRecord.fromRow(rows.single);
  }

  static bool _sameColumns(
    Map<String, Object?> stored,
    Map<String, Object?> expected,
  ) {
    return expected.entries.every((entry) => stored[entry.key] == entry.value);
  }

  static DesktopCaptureCommandReceipt _receiptFromRow(
    Map<String, Object?> row,
  ) {
    return DesktopCaptureCommandReceipt(
      sessionId: row['session_id']! as String,
      idempotencyKey: row['idempotency_key']! as String,
      action: row['action']! as String,
      result: (jsonDecode(row['result_json']! as String) as Map)
          .cast<String, Object?>(),
      createdAtMs: row['created_at_ms']! as int,
    );
  }

  static bool _validTransition(String current, String next) {
    if (current == next) {
      return true;
    }
    return switch (current) {
      'preparing' => {
        'recording',
        'partial_capture',
        'failed',
        'recoverable',
      }.contains(next),
      'recording' => {
        'paused',
        'finalizing',
        'completed',
        'partial_capture',
        'recoverable',
        'failed',
      }.contains(next),
      'paused' => {
        'recording',
        'finalizing',
        'completed',
        'partial_capture',
        'recoverable',
        'failed',
      }.contains(next),
      'finalizing' => {
        'completed',
        'partial_capture',
        'recoverable',
        'failed',
      }.contains(next),
      'recoverable' => {
        'finalizing',
        'completed',
        'partial_capture',
        'failed',
      }.contains(next),
      'partial_capture' => {
        'finalizing',
        'completed',
        'recoverable',
        'failed',
      }.contains(next),
      'completed' || 'failed' => false,
      _ => false,
    };
  }
}
