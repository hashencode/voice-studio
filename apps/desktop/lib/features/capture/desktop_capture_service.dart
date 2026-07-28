import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;

import 'desktop_capture_models.dart';
import 'desktop_capture_port.dart';
import 'desktop_capture_recovery.dart';
import 'desktop_capture_workspace.dart';

class DesktopCaptureService implements MeetingCaptureCommitPort {
  DesktopCaptureService({
    required DesktopCapturePort port,
    required DesktopCaptureRepository repository,
    required DesktopCaptureWorkspace workspace,
    required DesktopCaptureRecovery recovery,
    DateTime Function()? clock,
  }) : _port = port,
       _repository = repository,
       _workspace = workspace,
       _recovery = recovery,
       _clock = clock ?? DateTime.now;

  final DesktopCapturePort _port;
  final DesktopCaptureRepository _repository;
  final DesktopCaptureWorkspace _workspace;
  final DesktopCaptureRecovery _recovery;
  final DateTime Function() _clock;

  Stream<DesktopCaptureSessionSnapshot> get snapshots => _port.snapshots;
  Stream<DesktopCaptureMenuAction> get menuActions => _port.menuActions;

  Future<DesktopCaptureSessionRecord?> sessionRecord(String sessionId) {
    return _repository.findSession(sessionId);
  }

  Future<DesktopCapturePreflight> preflight({
    required int minimumFreeBytes,
    required bool captionModelAvailable,
    bool requestPermissions = false,
  }) {
    return _port.preflight(
      sessionRoot: _workspace.root.path,
      minimumFreeBytes: minimumFreeBytes,
      captionModelAvailable: captionModelAvailable,
      requestPermissions: requestPermissions,
    );
  }

  Future<DesktopCaptureSessionSnapshot> start({
    required String sessionId,
    required String idempotencyKey,
    required int minimumFreeBytes,
    String? microphoneDeviceId,
    bool captionEnabled = false,
  }) async {
    final cached = await _cached(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      action: 'start',
    );
    if (cached != null) {
      return cached;
    }
    final directory = await _workspace.createSession(sessionId);
    final nowMs = _clock().millisecondsSinceEpoch;
    await _repository.beginSession(
      sessionId: sessionId,
      workspacePath: directory.path,
      nowMs: nowMs,
    );
    final snapshot = await _port.start(
      DesktopCaptureStartRequest(
        sessionId: sessionId,
        sessionRoot: directory.path,
        idempotencyKey: idempotencyKey,
        minimumFreeBytes: minimumFreeBytes,
        microphoneDeviceId: microphoneDeviceId,
        captionEnabled: captionEnabled,
      ),
    );
    await _persistSnapshot(
      snapshot,
      action: 'start',
      idempotencyKey: idempotencyKey,
    );
    return snapshot;
  }

  Future<DesktopCaptureSessionSnapshot> pause({
    required String sessionId,
    required String idempotencyKey,
  }) {
    return _control(
      action: 'pause',
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      invoke: () =>
          _port.pause(sessionId: sessionId, idempotencyKey: idempotencyKey),
    );
  }

  Future<DesktopCaptureSessionSnapshot> resume({
    required String sessionId,
    required String idempotencyKey,
  }) {
    return _control(
      action: 'resume',
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      invoke: () =>
          _port.resume(sessionId: sessionId, idempotencyKey: idempotencyKey),
    );
  }

  Future<DesktopCaptureSessionSnapshot> stop({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    final cached = await _cached(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      action: 'stop',
    );
    if (cached != null) {
      return cached;
    }
    final native = await _port.stop(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
    );
    final recovery = await _recovery.reconcileJournals();
    final recovered = recovery.where((value) => value.sessionId == sessionId);
    if (recovered.isEmpty ||
        recovered.single.error != null ||
        recovered.single.validatedChunkCount == 0) {
      throw StateError(
        'Capture journal did not pass durable recovery validation',
      );
    }
    final session = await _repository.findSession(sessionId);
    if (session == null) {
      throw StateError('Capture session disappeared before commit');
    }
    final manifest = File(p.join(session.workspacePath, 'journal.json'));
    final manifestHash = await sha256.bind(manifest.openRead()).first;
    final receipt = await _repository.commitCaptureManifest(
      sessionId: sessionId,
      manifestPath: manifest.path,
      displayName: displayName,
      durationMs: native.captureTimelineMs,
      recordingSha256: manifestHash.toString(),
      partialCapture: native.partialCapture,
      idempotencyKey: idempotencyKey,
      nativeResult: native.toMap(),
      nowMs: _clock().millisecondsSinceEpoch,
    );
    return DesktopCaptureSessionSnapshot.fromMap(receipt.result);
  }

  @override
  Future<CommittedMeetingCapture> stopAndCommit({
    required String sessionId,
    required String idempotencyKey,
    required String displayName,
  }) async {
    final snapshot = await stop(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      displayName: displayName,
    );
    final durable = await _repository.findSession(sessionId);
    if (durable == null ||
        durable.recordingId == null ||
        durable.recordingSha256 == null) {
      throw StateError('Capture recording was not durably committed');
    }
    final processingPath = await _materializeProcessingMix(
      durable.workspacePath,
    );
    return CommittedMeetingCapture(
      sessionId: sessionId,
      recordingId: durable.recordingId!,
      recordingPath: p.join(durable.workspacePath, 'journal.json'),
      processingPath: processingPath,
      recordingSha256: durable.recordingSha256!,
      durationMs: snapshot.captureTimelineMs,
      partialCapture: snapshot.partialCapture,
    );
  }

  Future<CommittedMeetingCapture> keepRecovered({
    required String sessionId,
    required String displayName,
  }) async {
    final durable = await _repository.findSession(sessionId);
    if (durable == null ||
        !{'recoverable', 'partial_capture'}.contains(durable.state)) {
      throw StateError('Capture session is not recoverable');
    }
    if (durable.recordingId == null) {
      final manifest = File(p.join(durable.workspacePath, 'journal.json'));
      final manifestHash = await sha256.bind(manifest.openRead()).first;
      await _repository.commitCaptureManifest(
        sessionId: sessionId,
        manifestPath: manifest.path,
        displayName: displayName,
        durationMs: durable.captureTimelineMs,
        recordingSha256: manifestHash.toString(),
        partialCapture: true,
        idempotencyKey: 'keep-recovered-$sessionId',
        nativeResult: <String, Object?>{
          'sessionId': sessionId,
          'state': 'partial_capture',
          'captureTimelineMs': durable.captureTimelineMs,
          'systemAudioHealthy': false,
          'microphoneHealthy': false,
          'partialCapture': true,
          'finalizedChunkCount': 0,
          'eventCount': 0,
        },
        nowMs: _clock().millisecondsSinceEpoch,
      );
    }
    final committed = (await _repository.findSession(sessionId))!;
    await _repository.setRecoveryDisposition(
      sessionId: sessionId,
      disposition: 'kept_partial',
      nowMs: _clock().millisecondsSinceEpoch,
    );
    return CommittedMeetingCapture(
      sessionId: sessionId,
      recordingId: committed.recordingId!,
      recordingPath: p.join(committed.workspacePath, 'journal.json'),
      processingPath: await _materializeProcessingMix(committed.workspacePath),
      recordingSha256: committed.recordingSha256!,
      durationMs: committed.captureTimelineMs,
      partialCapture: true,
    );
  }

  Future<void> discardRecovered(String sessionId) async {
    final durable = await _repository.findSession(sessionId);
    if (durable == null ||
        durable.recordingId != null ||
        !{'recoverable', 'partial_capture'}.contains(durable.state)) {
      throw StateError('Capture session cannot be discarded');
    }
    await _repository.setRecoveryDisposition(
      sessionId: sessionId,
      disposition: 'discarded',
      nowMs: _clock().millisecondsSinceEpoch,
    );
    await _workspace.discardSession(sessionId);
  }

  Future<List<DesktopCaptureRecoveryResult>> recoverInterrupted() {
    return _recovery.reconcile(_port);
  }

  Future<DesktopCaptureSessionSnapshot> _control({
    required String action,
    required String sessionId,
    required String idempotencyKey,
    required Future<DesktopCaptureSessionSnapshot> Function() invoke,
  }) async {
    final cached = await _cached(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
      action: action,
    );
    if (cached != null) {
      return cached;
    }
    final snapshot = await invoke();
    await _persistSnapshot(
      snapshot,
      action: action,
      idempotencyKey: idempotencyKey,
    );
    return snapshot;
  }

  Future<void> _persistSnapshot(
    DesktopCaptureSessionSnapshot snapshot, {
    required String action,
    required String idempotencyKey,
  }) {
    return _repository.saveSnapshotAndReceipt(
      sessionId: snapshot.sessionId,
      state: snapshot.state.wireName,
      captureTimelineMs: snapshot.captureTimelineMs,
      partialCapture: snapshot.partialCapture,
      action: action,
      idempotencyKey: idempotencyKey,
      result: snapshot.toMap(),
      nowMs: _clock().millisecondsSinceEpoch,
    );
  }

  Future<DesktopCaptureSessionSnapshot?> _cached({
    required String sessionId,
    required String idempotencyKey,
    required String action,
  }) async {
    final receipt = await _repository.commandReceipt(
      sessionId: sessionId,
      idempotencyKey: idempotencyKey,
    );
    if (receipt == null) {
      return null;
    }
    if (receipt.action != action) {
      throw StateError(
        'Capture idempotency key was reused with different intent',
      );
    }
    return DesktopCaptureSessionSnapshot.fromMap(receipt.result);
  }

  Future<String> _materializeProcessingMix(String workspacePath) async {
    final source = File(
      p.join(workspacePath, 'caption', 'live-caption.pcmspool'),
    );
    if (!await source.exists()) {
      throw StateError('Derived capture mix is unavailable');
    }
    final sourceBytes = await source.length();
    const frameBytes = 1600 * 2;
    final alignedBytes = sourceBytes - sourceBytes % frameBytes;
    if (alignedBytes <= 0) throw StateError('Derived capture mix is empty');
    final directory = Directory(p.join(workspacePath, 'processing'));
    await directory.create(recursive: true);
    final destination = File(p.join(directory.path, 'qwen3-post-meeting.wav'));
    if (await destination.exists()) {
      if (await destination.length() == alignedBytes + 44) {
        return destination.path;
      }
      throw StateError('Derived processing mix drifted');
    }
    final partial = File('${destination.path}.partial');
    if (await partial.exists()) await partial.delete();
    final output = await partial.open(mode: FileMode.write);
    try {
      await output.writeFrom(_wavHeader(alignedBytes));
      await for (final chunk in source.openRead(0, alignedBytes)) {
        await output.writeFrom(chunk);
      }
      await output.flush();
    } finally {
      await output.close();
    }
    await partial.rename(destination.path);
    return destination.path;
  }

  static Uint8List _wavHeader(int pcmBytes) {
    final header = ByteData(44);
    void ascii(int offset, String value) {
      for (var index = 0; index < value.length; index += 1) {
        header.setUint8(offset + index, value.codeUnitAt(index));
      }
    }

    ascii(0, 'RIFF');
    header.setUint32(4, pcmBytes + 36, Endian.little);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header
      ..setUint32(16, 16, Endian.little)
      ..setUint16(20, 1, Endian.little)
      ..setUint16(22, 1, Endian.little)
      ..setUint32(24, 16000, Endian.little)
      ..setUint32(28, 32000, Endian.little)
      ..setUint16(32, 2, Endian.little)
      ..setUint16(34, 16, Endian.little);
    ascii(36, 'data');
    header.setUint32(40, pcmBytes, Endian.little);
    return header.buffer.asUint8List();
  }
}
