import 'dart:async';

enum SpeakerAssignment { anonymous, overlap, unknown }

class ProcessingTargetFingerprint {
  const ProcessingTargetFingerprint({
    required this.operatingSystem,
    required this.operatingSystemVersion,
    required this.architecture,
    required this.cpuModel,
    required this.logicalCpuCount,
    required this.memoryBytes,
    required this.runtimeId,
    required this.runtimeVersion,
    required this.runtimeSha256,
  });

  final String operatingSystem;
  final String operatingSystemVersion;
  final String architecture;
  final String cpuModel;
  final int logicalCpuCount;
  final int memoryBytes;
  final String runtimeId;
  final String runtimeVersion;
  final String runtimeSha256;

  Map<String, Object> toJson() => {
    'operatingSystem': operatingSystem,
    'operatingSystemVersion': operatingSystemVersion,
    'architecture': architecture,
    'cpuModel': cpuModel,
    'logicalCpuCount': logicalCpuCount,
    'memoryBytes': memoryBytes,
    'runtimeId': runtimeId,
    'runtimeVersion': runtimeVersion,
    'runtimeSha256': runtimeSha256,
  };
}

class ProcessingModelIdentity {
  const ProcessingModelIdentity({
    required this.id,
    required this.version,
    required this.sha256,
    required this.licenseSpdx,
  });

  final String id;
  final String version;
  final String sha256;
  final String licenseSpdx;

  Map<String, String> toJson() => {
    'id': id,
    'version': version,
    'sha256': sha256,
    'licenseSpdx': licenseSpdx,
  };
}

class ProcessingFixtureIdentity {
  const ProcessingFixtureIdentity({
    required this.id,
    required this.sha256,
    required this.durationSeconds,
  });

  final String id;
  final String sha256;
  final double durationSeconds;

  Map<String, Object> toJson() => {
    'id': id,
    'sha256': sha256,
    'durationSeconds': durationSeconds,
  };
}

class ProcessingTranscriptSegment {
  const ProcessingTranscriptSegment({
    required this.startSeconds,
    required this.endSeconds,
    required this.text,
    required this.speakerAssignment,
    this.anonymousSpeakerKey,
  });

  final double startSeconds;
  final double endSeconds;
  final String text;
  final SpeakerAssignment speakerAssignment;
  final String? anonymousSpeakerKey;

  Map<String, Object?> toJson() => {
    'startSeconds': startSeconds,
    'endSeconds': endSeconds,
    'text': text,
    'speakerAssignment': speakerAssignment.name,
    'anonymousSpeakerKey': anonymousSpeakerKey,
  };
}

class ProcessingRequest {
  const ProcessingRequest({
    required this.sourcePath,
    required this.sourceSha256,
    required this.durationSeconds,
  });

  final String sourcePath;
  final String sourceSha256;
  final double durationSeconds;
}

class ProcessingProgress {
  const ProcessingProgress({required this.phase, required this.fraction});

  final String phase;
  final double fraction;
}

class ProcessingCancellationToken {
  bool _cancelled = false;
  DateTime? _deadline;

  bool get deadlineExceeded =>
      _deadline != null && !DateTime.now().isBefore(_deadline!);

  bool get isCancelled => _cancelled || deadlineExceeded;

  void cancel() => _cancelled = true;

  void setDeadline(Duration timeout) {
    if (timeout <= Duration.zero) {
      _deadline = DateTime.now();
      return;
    }
    final candidate = DateTime.now().add(timeout);
    if (_deadline == null || candidate.isBefore(_deadline!)) {
      _deadline = candidate;
    }
  }

  void throwIfCancelled() {
    if (_cancelled) throw const ProcessingCancelled();
    if (deadlineExceeded) throw const ProcessingTimedOut();
  }
}

class ProcessingCancelled implements Exception {
  const ProcessingCancelled();
}

class ProcessingTimedOut implements Exception {
  const ProcessingTimedOut();
}

abstract interface class ProcessingTemporaryLease {
  Future<void> release();
}

class ProcessingJobSupervisor {
  const ProcessingJobSupervisor();

  Future<ProcessingResult> run({
    required ProcessingEnginePort engine,
    required ProcessingRequest request,
    required ProcessingCancellationToken cancellationToken,
    required ProcessingTemporaryLease temporaryLease,
    required Duration timeout,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    cancellationToken.setDeadline(timeout);
    final timeoutCompleter = Completer<ProcessingResult>();
    final timer = Timer(timeout, () {
      cancellationToken.cancel();
      timeoutCompleter.completeError(const ProcessingTimedOut());
    });
    try {
      return await Future.any<ProcessingResult>(<Future<ProcessingResult>>[
        engine.process(
          request,
          cancellationToken: cancellationToken,
          onProgress: onProgress,
        ),
        timeoutCompleter.future,
      ]);
    } finally {
      timer.cancel();
      await temporaryLease.release();
    }
  }
}

class ProcessingResult {
  const ProcessingResult({
    required this.segments,
    required this.engineId,
    required this.elapsedMilliseconds,
    required this.peakResidentBytes,
  });

  final List<ProcessingTranscriptSegment> segments;
  final String engineId;
  final int elapsedMilliseconds;
  final int peakResidentBytes;
}

abstract interface class ProcessingEnginePort {
  String get engineId;

  Future<ProcessingResult> process(
    ProcessingRequest request, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  });
}

class NonAiAudioExport {
  const NonAiAudioExport._();

  static String toWebVtt(List<ProcessingTranscriptSegment> segments) {
    final buffer = StringBuffer('WEBVTT\n\n');
    for (var index = 0; index < segments.length; index += 1) {
      final segment = segments[index];
      buffer
        ..writeln(index + 1)
        ..writeln(
          '${_timestamp(segment.startSeconds)} --> ${_timestamp(segment.endSeconds)}',
        )
        ..writeln(
          '[${segment.anonymousSpeakerKey ?? segment.speakerAssignment.name}] '
          '${segment.text}',
        )
        ..writeln();
    }
    return buffer.toString();
  }

  static String _timestamp(double seconds) {
    final milliseconds = (seconds * 1000).round();
    final hours = milliseconds ~/ 3600000;
    final minutes = (milliseconds % 3600000) ~/ 60000;
    final secs = (milliseconds % 60000) ~/ 1000;
    final millis = milliseconds % 1000;
    return '${hours.toString().padLeft(2, '0')}:'
        '${minutes.toString().padLeft(2, '0')}:'
        '${secs.toString().padLeft(2, '0')}.'
        '${millis.toString().padLeft(3, '0')}';
  }
}

class ReviewableAudioTranscript {
  ReviewableAudioTranscript(List<ProcessingTranscriptSegment> segments)
    : _segments = List<ProcessingTranscriptSegment>.of(segments);

  final List<ProcessingTranscriptSegment> _segments;
  int _revisionCount = 0;

  List<ProcessingTranscriptSegment> get segments =>
      List<ProcessingTranscriptSegment>.unmodifiable(_segments);

  int get revisionCount => _revisionCount;

  void correctText(int index, String correctedText) {
    if (index < 0 || index >= _segments.length) {
      throw RangeError.index(index, _segments);
    }
    final normalized = correctedText.trim();
    if (normalized.isEmpty) {
      throw const FormatException('Corrected transcript text cannot be empty');
    }
    final current = _segments[index];
    _segments[index] = ProcessingTranscriptSegment(
      startSeconds: current.startSeconds,
      endSeconds: current.endSeconds,
      text: normalized,
      speakerAssignment: current.speakerAssignment,
      anonymousSpeakerKey: current.anonymousSpeakerKey,
    );
    _revisionCount += 1;
  }
}
