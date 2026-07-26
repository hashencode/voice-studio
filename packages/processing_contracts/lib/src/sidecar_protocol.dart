import 'dart:convert';

import 'processing_engine_port.dart';
import 'processing_operational_envelope.dart';

const int sidecarProtocolVersion = 1;
const int sidecarMaximumJsonLineBytes = 1024 * 1024;
const int sidecarMaximumMessageIdLength = 128;
const int sidecarMaximumTextBytes = 32 * 1024;

enum SidecarMessageType {
  handshake,
  capability,
  job,
  progress,
  result,
  error,
  cancel,
  shutdown,
}

class SidecarProtocolException implements Exception {
  const SidecarProtocolException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => '$code: $message';
}

class SidecarEnvelope {
  SidecarEnvelope({
    required this.type,
    required this.messageId,
    required this.payload,
    this.jobId,
    this.attemptId,
  }) {
    _requireIdentifier(messageId, 'messageId');
    if (jobId != null) _requireIdentifier(jobId!, 'jobId');
    if (attemptId != null) _requireIdentifier(attemptId!, 'attemptId');
  }

  final SidecarMessageType type;
  final String messageId;
  final String? jobId;
  final String? attemptId;
  final Map<String, Object?> payload;

  String encode() {
    final line = jsonEncode(<String, Object?>{
      'protocolVersion': sidecarProtocolVersion,
      'type': type.name,
      'messageId': messageId,
      'jobId': jobId,
      'attemptId': attemptId,
      'payload': payload,
    });
    if (utf8.encode(line).length > sidecarMaximumJsonLineBytes) {
      throw const SidecarProtocolException(
        'SIDECAR_OUTPUT_LIMIT',
        'Sidecar JSONL message exceeds the byte limit.',
      );
    }
    return line;
  }

  static SidecarEnvelope decode(String line) {
    if (utf8.encode(line).length > sidecarMaximumJsonLineBytes) {
      throw const SidecarProtocolException(
        'SIDECAR_OUTPUT_LIMIT',
        'Sidecar JSONL message exceeds the byte limit.',
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(line);
    } on FormatException {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_JSON',
        'Sidecar emitted invalid JSON.',
      );
    }
    if (decoded is! Map<String, Object?>) {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_ENVELOPE',
        'Sidecar envelope must be a JSON object.',
      );
    }
    const allowed = <String>{
      'protocolVersion',
      'type',
      'messageId',
      'jobId',
      'attemptId',
      'payload',
    };
    if (decoded.keys.any((key) => !allowed.contains(key))) {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_ENVELOPE',
        'Sidecar envelope contains an unknown field.',
      );
    }
    if (decoded['protocolVersion'] != sidecarProtocolVersion) {
      throw const SidecarProtocolException(
        'SIDECAR_VERSION_MISMATCH',
        'Sidecar protocol version does not match.',
      );
    }
    final typeName = decoded['type'];
    final type = SidecarMessageType.values
        .where((candidate) => candidate.name == typeName)
        .firstOrNull;
    if (type == null) {
      throw const SidecarProtocolException(
        'SIDECAR_MESSAGE_TYPE_UNSUPPORTED',
        'Sidecar message type is unsupported.',
      );
    }
    final messageId = decoded['messageId'];
    final payload = decoded['payload'];
    if (messageId is! String || payload is! Map<String, Object?>) {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_ENVELOPE',
        'Sidecar message identifier or payload is invalid.',
      );
    }
    final jobId = decoded['jobId'];
    final attemptId = decoded['attemptId'];
    if (jobId != null && jobId is! String ||
        attemptId != null && attemptId is! String) {
      throw const SidecarProtocolException(
        'SIDECAR_INVALID_ENVELOPE',
        'Sidecar job identifiers are invalid.',
      );
    }
    return SidecarEnvelope(
      type: type,
      messageId: messageId,
      jobId: jobId as String?,
      attemptId: attemptId as String?,
      payload: payload,
    );
  }
}

class SidecarHandshake {
  SidecarHandshake({
    required this.runtimeId,
    required this.runtimeVersion,
    required this.capabilities,
  }) {
    _requireIdentifier(runtimeId, 'runtimeId');
    _requireIdentifier(runtimeVersion, 'runtimeVersion');
    if (capabilities.isEmpty) {
      throw const SidecarProtocolException(
        'SIDECAR_CAPABILITY_MISMATCH',
        'Sidecar advertised no capabilities.',
      );
    }
  }

  final String runtimeId;
  final String runtimeVersion;
  final Set<String> capabilities;

  factory SidecarHandshake.fromEnvelope(SidecarEnvelope envelope) {
    if (envelope.type != SidecarMessageType.handshake ||
        envelope.jobId != null ||
        envelope.attemptId != null) {
      throw const SidecarProtocolException(
        'SIDECAR_HANDSHAKE_INVALID',
        'Expected a session-level handshake.',
      );
    }
    final runtimeId = envelope.payload['runtimeId'];
    final runtimeVersion = envelope.payload['runtimeVersion'];
    final rawCapabilities = envelope.payload['capabilities'];
    if (runtimeId is! String ||
        runtimeVersion is! String ||
        rawCapabilities is! List<Object?> ||
        rawCapabilities.any((value) => value is! String)) {
      throw const SidecarProtocolException(
        'SIDECAR_HANDSHAKE_INVALID',
        'Sidecar handshake payload is invalid.',
      );
    }
    return SidecarHandshake(
      runtimeId: runtimeId,
      runtimeVersion: runtimeVersion,
      capabilities: rawCapabilities.cast<String>().toSet(),
    );
  }

  void requireExpected({
    required String expectedRuntimeId,
    required String expectedRuntimeVersion,
    required Set<String> requiredCapabilities,
  }) {
    if (runtimeId != expectedRuntimeId ||
        runtimeVersion != expectedRuntimeVersion) {
      throw const SidecarProtocolException(
        'SIDECAR_VERSION_MISMATCH',
        'Sidecar runtime identity does not match the manifest.',
      );
    }
    if (!capabilities.containsAll(requiredCapabilities)) {
      throw const SidecarProtocolException(
        'SIDECAR_CAPABILITY_MISMATCH',
        'Sidecar does not expose the required capabilities.',
      );
    }
  }
}

class SidecarJobRequest {
  SidecarJobRequest({
    required this.jobId,
    required this.attemptId,
    required this.sourceRelativePath,
    required this.sourceSha256,
    required this.sourceBytes,
    required this.durationSeconds,
    required this.capability,
    required this.maxSegments,
  }) {
    _requireIdentifier(jobId, 'jobId');
    _requireIdentifier(attemptId, 'attemptId');
    SidecarRelativePath.requireSafe(sourceRelativePath);
    if (!_sha256.hasMatch(sourceSha256)) {
      throw const SidecarProtocolException(
        'SIDECAR_SOURCE_IDENTITY_INVALID',
        'Source SHA-256 is invalid.',
      );
    }
    if (sourceBytes <= 0 ||
        durationSeconds <= 0 ||
        maxSegments <= 0 ||
        maxSegments > ProcessingOperationalEnvelope.desktopV1.maxSegments) {
      throw const SidecarProtocolException(
        'SIDECAR_JOB_LIMIT_INVALID',
        'Sidecar job limits are invalid.',
      );
    }
  }

  final String jobId;
  final String attemptId;
  final String sourceRelativePath;
  final String sourceSha256;
  final int sourceBytes;
  final double durationSeconds;
  final String capability;
  final int maxSegments;

  SidecarEnvelope toEnvelope(String messageId) => SidecarEnvelope(
    type: SidecarMessageType.job,
    messageId: messageId,
    jobId: jobId,
    attemptId: attemptId,
    payload: <String, Object?>{
      'source': <String, Object?>{
        'root': 'job',
        'relativePath': sourceRelativePath,
        'sha256': sourceSha256,
        'bytes': sourceBytes,
      },
      'durationSeconds': durationSeconds,
      'capability': capability,
      'maxSegments': maxSegments,
    },
  );
}

class SidecarResult {
  SidecarResult({
    required this.jobId,
    required this.attemptId,
    required this.engineId,
    required this.segments,
  });

  final String jobId;
  final String attemptId;
  final String engineId;
  final List<ProcessingTranscriptSegment> segments;

  factory SidecarResult.fromEnvelope(
    SidecarEnvelope envelope, {
    required String expectedJobId,
    required String expectedAttemptId,
    required double durationSeconds,
    required int maxSegments,
  }) {
    if (envelope.type != SidecarMessageType.result) {
      throw const SidecarProtocolException(
        'SIDECAR_RESULT_INVALID',
        'Expected a sidecar result.',
      );
    }
    if (envelope.jobId != expectedJobId ||
        envelope.attemptId != expectedAttemptId) {
      throw const SidecarProtocolException(
        'SIDECAR_STALE_RESULT',
        'Sidecar result belongs to a stale job attempt.',
      );
    }
    final engineId = envelope.payload['engineId'];
    final rawSegments = envelope.payload['segments'];
    if (engineId is! String || rawSegments is! List<Object?>) {
      throw const SidecarProtocolException(
        'SIDECAR_RESULT_INVALID',
        'Sidecar result payload is invalid.',
      );
    }
    _requireIdentifier(engineId, 'engineId');
    if (rawSegments.isEmpty || rawSegments.length > maxSegments) {
      throw const SidecarProtocolException(
        'SIDECAR_OUTPUT_LIMIT',
        'Sidecar segment output is empty or exceeds the limit.',
      );
    }
    final segments = <ProcessingTranscriptSegment>[];
    for (final raw in rawSegments) {
      if (raw is! Map<String, Object?>) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Sidecar segment must be an object.',
        );
      }
      final start = raw['startSeconds'];
      final end = raw['endSeconds'];
      final text = raw['text'];
      final assignmentName = raw['speakerAssignment'];
      final anonymousKey = raw['anonymousSpeakerKey'];
      final assignment = SpeakerAssignment.values
          .where((candidate) => candidate.name == assignmentName)
          .firstOrNull;
      if (start is! num ||
          end is! num ||
          text is! String ||
          assignment == null ||
          anonymousKey != null && anonymousKey is! String ||
          start < 0 ||
          end <= start ||
          end > durationSeconds + 0.001 ||
          text.trim().isEmpty ||
          utf8.encode(text).length > sidecarMaximumTextBytes) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Sidecar segment is invalid or out of bounds.',
        );
      }
      if (assignment == SpeakerAssignment.anonymous &&
          (anonymousKey is! String ||
              !RegExp(r'^speaker_[0-9]{2,}$').hasMatch(anonymousKey))) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Anonymous speaker assignment lacks an anonymous key.',
        );
      }
      if (assignment != SpeakerAssignment.anonymous && anonymousKey != null) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Overlap or unknown assignment cannot carry a speaker identity.',
        );
      }
      segments.add(
        ProcessingTranscriptSegment(
          startSeconds: start.toDouble(),
          endSeconds: end.toDouble(),
          text: text,
          speakerAssignment: assignment,
          anonymousSpeakerKey: anonymousKey as String?,
        ),
      );
    }
    return SidecarResult(
      jobId: expectedJobId,
      attemptId: expectedAttemptId,
      engineId: engineId,
      segments: List<ProcessingTranscriptSegment>.unmodifiable(segments),
    );
  }
}

class SidecarSpeakerTurn {
  const SidecarSpeakerTurn({
    required this.startSeconds,
    required this.endSeconds,
    required this.speakerAssignment,
    this.anonymousSpeakerKey,
  });

  final double startSeconds;
  final double endSeconds;
  final SpeakerAssignment speakerAssignment;
  final String? anonymousSpeakerKey;
}

class SidecarSpeakerTurnResult {
  const SidecarSpeakerTurnResult({
    required this.jobId,
    required this.attemptId,
    required this.engineId,
    required this.turns,
  });

  final String jobId;
  final String attemptId;
  final String engineId;
  final List<SidecarSpeakerTurn> turns;

  factory SidecarSpeakerTurnResult.fromEnvelope(
    SidecarEnvelope envelope, {
    required String expectedJobId,
    required String expectedAttemptId,
    required double durationSeconds,
    required int maxSegments,
  }) {
    if (envelope.type != SidecarMessageType.result ||
        envelope.jobId != expectedJobId ||
        envelope.attemptId != expectedAttemptId) {
      throw const SidecarProtocolException(
        'SIDECAR_STALE_RESULT',
        'Sidecar speaker result belongs to a stale job attempt.',
      );
    }
    final engineId = envelope.payload['engineId'];
    final rawTurns = envelope.payload['speakerTurns'];
    if (engineId is! String ||
        rawTurns is! List<Object?> ||
        rawTurns.isEmpty ||
        rawTurns.length > maxSegments) {
      throw const SidecarProtocolException(
        'SIDECAR_RESULT_INVALID',
        'Sidecar speaker result is invalid or exceeds the limit.',
      );
    }
    _requireIdentifier(engineId, 'engineId');
    final turns = <SidecarSpeakerTurn>[];
    for (final raw in rawTurns) {
      if (raw is! Map<String, Object?>) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Sidecar speaker turn must be an object.',
        );
      }
      final start = raw['startSeconds'];
      final end = raw['endSeconds'];
      final assignmentName = raw['speakerAssignment'];
      final anonymousKey = raw['anonymousSpeakerKey'];
      final assignment = SpeakerAssignment.values
          .where((candidate) => candidate.name == assignmentName)
          .firstOrNull;
      if (start is! num ||
          end is! num ||
          assignment == null ||
          anonymousKey != null && anonymousKey is! String ||
          start < 0 ||
          end <= start ||
          end > durationSeconds + 0.001) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Sidecar speaker turn is out of bounds.',
        );
      }
      if (assignment == SpeakerAssignment.anonymous &&
          (anonymousKey is! String ||
              !RegExp(r'^speaker_[0-9]{2,}$').hasMatch(anonymousKey))) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Anonymous speaker turn lacks an anonymous key.',
        );
      }
      if (assignment != SpeakerAssignment.anonymous && anonymousKey != null) {
        throw const SidecarProtocolException(
          'SIDECAR_RESULT_INVALID',
          'Overlap or unknown turn cannot carry a speaker identity.',
        );
      }
      turns.add(
        SidecarSpeakerTurn(
          startSeconds: start.toDouble(),
          endSeconds: end.toDouble(),
          speakerAssignment: assignment,
          anonymousSpeakerKey: anonymousKey as String?,
        ),
      );
    }
    return SidecarSpeakerTurnResult(
      jobId: expectedJobId,
      attemptId: expectedAttemptId,
      engineId: engineId,
      turns: List<SidecarSpeakerTurn>.unmodifiable(turns),
    );
  }
}

class SidecarRelativePath {
  const SidecarRelativePath._();

  static void requireSafe(String path) {
    final normalized = path.replaceAll('\\', '/');
    final parts = normalized.split('/');
    if (path.isEmpty ||
        path.startsWith('/') ||
        RegExp(r'^[A-Za-z]:').hasMatch(path) ||
        normalized != path ||
        parts.any((part) => part.isEmpty || part == '.' || part == '..')) {
      throw const SidecarProtocolException(
        'SIDECAR_PATH_ESCAPE',
        'Sidecar path is not a contained relative path.',
      );
    }
  }
}

final RegExp _identifier = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:/+-]*$');
final RegExp _sha256 = RegExp(r'^[0-9a-f]{64}$');

void _requireIdentifier(String value, String label) {
  if (value.isEmpty ||
      value.length > sidecarMaximumMessageIdLength ||
      !_identifier.hasMatch(value)) {
    throw SidecarProtocolException(
      'SIDECAR_IDENTIFIER_INVALID',
      '$label is invalid.',
    );
  }
}
