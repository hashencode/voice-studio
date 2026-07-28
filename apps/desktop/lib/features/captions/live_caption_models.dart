import 'package:flutter/foundation.dart';

const String senseVoiceLiveDraftSource = 'sensevoice_live_draft';
const String qwen3PostMeetingSource = 'qwen3_post_meeting';
const String senseVoiceU18ControlProfile = 'U18_CONTROL_RETAINED';
const String liveCaptionSpoolRelativePath = 'caption/live-caption.pcmspool';
const int liveCaptionSampleRate = 16000;
const int liveCaptionBytesPerSample = 2;

enum LiveCaptionSessionState {
  preparing,
  running,
  paused,
  flushing,
  flushed,
  failed;

  String get storageValue => name;

  static LiveCaptionSessionState fromStorage(String value) =>
      values.singleWhere(
        (state) => state.storageValue == value,
        orElse: () =>
            throw FormatException('Unknown live-caption session state: $value'),
      );
}

enum TranscriptDisplayAuthority { none, liveDraft, formal, revisionRequired }

enum TranscriptReconciliationChoice { keepDraft, acceptFormal }

@immutable
class LiveCaptionUtterance {
  LiveCaptionUtterance({
    required this.sessionId,
    required this.generationId,
    required this.sequence,
    required this.startMs,
    required this.endMs,
    required this.text,
    required this.language,
    required this.modelSha256,
    required this.workerOffsetBytes,
  }) {
    if (!_safeId.hasMatch(sessionId) ||
        generationId <= 0 ||
        sequence <= 0 ||
        startMs < 0 ||
        endMs <= startMs ||
        text.trim().isEmpty ||
        text.runes.length > 4000 ||
        language.trim().isEmpty ||
        language.runes.length > 32 ||
        !_sha256.hasMatch(modelSha256) ||
        workerOffsetBytes < 0 ||
        workerOffsetBytes.isOdd) {
      throw const FormatException('Invalid live-caption utterance');
    }
  }

  factory LiveCaptionUtterance.fromWorkerEvent(
    Map<String, Object?> event, {
    required int generationId,
    required String modelSha256,
  }) {
    if (event['schemaVersion'] != 1 ||
        event['type'] != 'utterance' ||
        event['sessionId'] is! String ||
        event['sequence'] is! num ||
        event['startSeconds'] is! num ||
        event['endSeconds'] is! num ||
        event['text'] is! String ||
        event['language'] is! String ||
        event['offsetBytes'] is! num) {
      throw const FormatException('Invalid live-caption worker event');
    }
    return LiveCaptionUtterance(
      sessionId: event['sessionId']! as String,
      generationId: generationId,
      sequence: (event['sequence']! as num).toInt(),
      startMs: ((event['startSeconds']! as num).toDouble() * 1000).round(),
      endMs: ((event['endSeconds']! as num).toDouble() * 1000).round(),
      text: event['text']! as String,
      language: event['language']! as String,
      modelSha256: modelSha256,
      workerOffsetBytes: (event['offsetBytes']! as num).toInt(),
    );
  }

  final String sessionId;
  final int generationId;
  final int sequence;
  final int startMs;
  final int endMs;
  final String text;
  final String language;
  final String modelSha256;
  final int workerOffsetBytes;
}

@immutable
class LiveCaptionSessionRecord {
  const LiveCaptionSessionRecord({
    required this.sessionId,
    required this.generationId,
    required this.state,
    required this.spoolRelativePath,
    required this.workerOffsetBytes,
    required this.lastSequence,
    required this.modelSha256,
    required this.profileId,
    required this.createdAtMs,
    required this.updatedAtMs,
    this.recordingId,
    this.errorCode,
  });

  factory LiveCaptionSessionRecord.fromRow(Map<String, Object?> row) {
    return LiveCaptionSessionRecord(
      sessionId: row['session_id']! as String,
      generationId: row['generation_id']! as int,
      recordingId: row['recording_id'] as int?,
      state: LiveCaptionSessionState.fromStorage(row['state']! as String),
      spoolRelativePath: row['spool_relative_path']! as String,
      workerOffsetBytes: row['worker_offset_bytes']! as int,
      lastSequence: row['last_sequence']! as int,
      modelSha256: row['model_sha256']! as String,
      profileId: row['profile_id']! as String,
      errorCode: row['error_code'] as String?,
      createdAtMs: row['created_at_ms']! as int,
      updatedAtMs: row['updated_at_ms']! as int,
    );
  }

  final String sessionId;
  final int generationId;
  final int? recordingId;
  final LiveCaptionSessionState state;
  final String spoolRelativePath;
  final int workerOffsetBytes;
  final int lastSequence;
  final String modelSha256;
  final String profileId;
  final String? errorCode;
  final int createdAtMs;
  final int updatedAtMs;
}

@immutable
class TranscriptDisplaySnapshot {
  const TranscriptDisplaySnapshot({
    required this.authority,
    required this.generationId,
    required this.source,
    required this.isDraft,
    required this.requiresReconciliation,
  });

  const TranscriptDisplaySnapshot.none()
    : authority = TranscriptDisplayAuthority.none,
      generationId = null,
      source = null,
      isDraft = false,
      requiresReconciliation = false;

  final TranscriptDisplayAuthority authority;
  final int? generationId;
  final String? source;
  final bool isDraft;
  final bool requiresReconciliation;
}

final RegExp _safeId = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
final RegExp _sha256 = RegExp(r'^[0-9a-f]{64}$');
