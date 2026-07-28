import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:path/path.dart' as p;

import 'desktop_capture_port.dart';
import 'desktop_capture_workspace.dart';

class DesktopCaptureRecoveryResult {
  const DesktopCaptureRecoveryResult({
    required this.sessionId,
    required this.state,
    required this.validatedChunkCount,
    required this.error,
    this.captureTimelineMs = 0,
    this.healthyTrackCount = 0,
    this.gapCount = 0,
    this.lastSafeChunkMs = 0,
    this.storageBytes = 0,
  });

  final String sessionId;
  final String state;
  final int validatedChunkCount;
  final String? error;
  final int captureTimelineMs;
  final int healthyTrackCount;
  final int gapCount;
  final int lastSafeChunkMs;
  final int storageBytes;
}

class DesktopCaptureRecovery {
  DesktopCaptureRecovery({
    required DesktopCaptureRepository repository,
    required DesktopCaptureWorkspace workspace,
    DateTime Function()? clock,
  }) : _repository = repository,
       _workspace = workspace,
       _clock = clock ?? DateTime.now;

  final DesktopCaptureRepository _repository;
  final DesktopCaptureWorkspace _workspace;
  final DateTime Function() _clock;

  Future<List<DesktopCaptureRecoveryResult>> reconcile(
    DesktopCapturePort port,
  ) async {
    await port.recoverableSessions(captureRoot: _workspace.root.path);
    return reconcileJournals();
  }

  Future<List<DesktopCaptureRecoveryResult>> reconcileJournals() async {
    final results = <DesktopCaptureRecoveryResult>[];
    for (final directory in await _workspace.sessionDirectories()) {
      final journal = File(p.join(directory.path, 'journal.json'));
      if (!await journal.exists()) {
        continue;
      }
      results.add(await _reconcileJournal(directory, journal));
    }
    return results;
  }

  Future<DesktopCaptureRecoveryResult> _reconcileJournal(
    Directory directory,
    File journal,
  ) async {
    final sessionId = p.basename(directory.path);
    final nowMs = _clock().millisecondsSinceEpoch;
    final durable = await _repository.beginSession(
      sessionId: sessionId,
      workspacePath: directory.path,
      nowMs: nowMs,
    );
    if (durable.recordingId != null ||
        durable.recoveryDisposition != null ||
        durable.state == 'completed' ||
        durable.state == 'failed') {
      return DesktopCaptureRecoveryResult(
        sessionId: sessionId,
        // A partial capture remains a truthful property of the recording, but
        // once it has a committed recording/disposition it is no longer a
        // recovery candidate on the next launch.
        state: durable.recordingId != null ? 'completed' : durable.state,
        validatedChunkCount: 0,
        error: null,
      );
    }
    try {
      final bytes = await journal.readAsBytes();
      final journalSha256 = sha256.convert(bytes).toString();
      final document = (jsonDecode(utf8.decode(bytes)) as Map)
          .cast<String, Object?>();
      _require(document['schema'] == 'desktop-capture-session/v1', 'schema');
      _require(document['sessionId'] == sessionId, 'sessionId');
      final captureMode = document['captureMode'] as String? ?? 'dual_track';
      _require(
        captureMode == 'dual_track' || captureMode == 'microphone_only',
        'captureMode',
      );
      final rawState = _string(document, 'state');
      final timelineMs = _nonNegativeInt(document, 'captureTimelineMs');
      final tracks = _list(document, 'tracks');
      final chunks = _list(document, 'chunks');
      final events = _list(document, 'events');
      _require(tracks.isNotEmpty && tracks.length <= 2, 'tracks');
      _require(chunks.length <= 100000, 'chunks');
      _require(events.length <= 100000, 'events');

      final trackKinds = <String>{};
      var healthyTrackCount = 0;
      for (final raw in tracks) {
        final track = (raw as Map).cast<String, Object?>();
        final kind = _string(track, 'kind');
        _require(kind == 'system_audio' || kind == 'microphone', 'track.kind');
        _require(trackKinds.add(kind), 'track.duplicate');
        if (track['healthy'] == true) healthyTrackCount += 1;
        final sampleRate = track['sampleRate'];
        final channels = track['channels'];
        _require(sampleRate is num && sampleRate > 0, 'track.sampleRate');
        _require(
          channels is int && channels >= 1 && channels <= 32,
          'track.channels',
        );
        await _repository.upsertTrack(
          DesktopCaptureTrackRecord(
            sessionId: sessionId,
            kind: kind,
            healthy: track['healthy'] == true,
            sampleRate: (sampleRate as num).toDouble(),
            channels: channels as int,
            format: _string(track, 'format'),
          ),
        );
      }
      _require(trackKinds.contains('microphone'), 'track.microphone');
      _require(
        captureMode == 'dual_track'
            ? trackKinds.containsAll(<String>{'system_audio', 'microphone'})
            : trackKinds.length == 1,
        'track.authority',
      );

      final referencedPaths = <String>{};
      var lastSafeChunkMs = 0;
      for (final raw in chunks) {
        final chunk = (raw as Map).cast<String, Object?>();
        final trackKind = _string(chunk, 'track');
        _require(trackKinds.contains(trackKind), 'chunk.track');
        final sequence = _nonNegativeInt(chunk, 'sequence');
        final startMs = _nonNegativeInt(chunk, 'startMs');
        final endMs = _nonNegativeInt(chunk, 'endMs');
        _require(endMs >= startMs, 'chunk.timeline');
        lastSafeChunkMs = endMs > lastSafeChunkMs ? endMs : lastSafeChunkMs;
        final relativePath = _string(chunk, 'relativePath');
        _require(
          RegExp(
            r'^(system|microphone)/chunk-[0-9]{6}\.caf$',
          ).hasMatch(relativePath),
          'chunk.relativePath',
        );
        _require(referencedPaths.add(relativePath), 'chunk.duplicatePath');
        final byteCount = _positiveInt(chunk, 'bytes');
        final expectedHash = _string(chunk, 'sha256');
        _require(
          RegExp(r'^[0-9a-f]{64}$').hasMatch(expectedHash),
          'chunk.sha256',
        );
        _require(chunk['finalized'] == true, 'chunk.finalized');
        final file = File(p.join(directory.path, relativePath));
        _require(p.isWithin(directory.path, file.path), 'chunk.containment');
        _require(await file.exists(), 'chunk.missing');
        _require(await file.length() == byteCount, 'chunk.bytes');
        final actualHash = await sha256.bind(file.openRead()).first;
        _require(actualHash.toString() == expectedHash, 'chunk.hash');
        await _repository.recordChunk(
          DesktopCaptureChunkRecord(
            sessionId: sessionId,
            trackKind: trackKind,
            sequence: sequence,
            startMs: startMs,
            endMs: endMs,
            relativePath: relativePath,
            bytes: byteCount,
            sha256: expectedHash,
            createdAtMs: nowMs,
          ),
        );
      }

      final eventSequences = <int>{};
      for (final raw in events) {
        final event = (raw as Map).cast<String, Object?>();
        final sequence = _nonNegativeInt(event, 'sequence');
        _require(eventSequences.add(sequence), 'event.duplicateSequence');
        await _repository.recordEvent(
          DesktopCaptureEventRecord(
            sessionId: sessionId,
            sequence: sequence,
            monotonicMs: _nonNegativeInt(event, 'monotonicMs'),
            kind: _string(event, 'kind'),
            trackKind: _string(event, 'track'),
            reason: _string(event, 'reason'),
            createdAtMs: nowMs,
          ),
        );
      }

      final recoveredState = switch (rawState) {
        'partial_capture' => 'partial_capture',
        'failed' => 'failed',
        _ => 'recoverable',
      };
      var recoveredTimelineMs = timelineMs;
      if (lastSafeChunkMs > recoveredTimelineMs) {
        recoveredTimelineMs = lastSafeChunkMs;
      }
      if (durable.captureTimelineMs > recoveredTimelineMs) {
        recoveredTimelineMs = durable.captureTimelineMs;
      }
      final result = <String, Object?>{
        'sessionId': sessionId,
        'state': recoveredState,
        'captureMode': captureMode,
        'captureTimelineMs': recoveredTimelineMs,
        'validatedChunkCount': chunks.length,
        'journalSha256': journalSha256,
      };
      await _repository.saveSnapshotAndReceipt(
        sessionId: sessionId,
        state: recoveredState,
        captureTimelineMs: recoveredTimelineMs,
        partialCapture: recoveredState == 'partial_capture',
        action: 'recover',
        idempotencyKey: 'recover-$journalSha256',
        result: result,
        nowMs: nowMs,
      );
      return DesktopCaptureRecoveryResult(
        sessionId: sessionId,
        state: recoveredState,
        validatedChunkCount: chunks.length,
        error: null,
        captureTimelineMs: recoveredTimelineMs,
        healthyTrackCount: healthyTrackCount,
        gapCount: events.length,
        lastSafeChunkMs: lastSafeChunkMs,
        storageBytes: await _directoryBytes(directory),
      );
    } catch (error) {
      final message = error.toString();
      final result = <String, Object?>{
        'sessionId': sessionId,
        'state': 'failed',
        'error': message.length <= 240 ? message : message.substring(0, 240),
      };
      final receiptHash = sha256.convert(utf8.encode(jsonEncode(result)));
      await _repository.saveSnapshotAndReceipt(
        sessionId: sessionId,
        state: 'failed',
        captureTimelineMs: durable.captureTimelineMs,
        partialCapture: false,
        action: 'recover',
        idempotencyKey: 'recover-failed-$receiptHash',
        result: result,
        nowMs: nowMs,
      );
      return DesktopCaptureRecoveryResult(
        sessionId: sessionId,
        state: 'failed',
        validatedChunkCount: 0,
        error: message,
      );
    }
  }

  static List<Object?> _list(Map<String, Object?> map, String key) {
    final value = map[key];
    if (value is! List) {
      throw FormatException('Invalid capture journal field: $key');
    }
    return value.cast<Object?>();
  }

  static String _string(Map<String, Object?> map, String key) {
    final value = map[key];
    if (value is! String || value.isEmpty) {
      throw FormatException('Invalid capture journal field: $key');
    }
    return value;
  }

  static int _nonNegativeInt(Map<String, Object?> map, String key) {
    final value = map[key];
    if (value is! int || value < 0) {
      throw FormatException('Invalid capture journal field: $key');
    }
    return value;
  }

  static int _positiveInt(Map<String, Object?> map, String key) {
    final value = _nonNegativeInt(map, key);
    if (value == 0) {
      throw FormatException('Invalid capture journal field: $key');
    }
    return value;
  }

  static void _require(bool condition, String field) {
    if (!condition) {
      throw FormatException('Invalid capture journal field: $field');
    }
  }

  static Future<int> _directoryBytes(Directory directory) async {
    var total = 0;
    await for (final entity in directory.list(recursive: true)) {
      if (entity is File) total += await entity.length();
    }
    return total;
  }
}
