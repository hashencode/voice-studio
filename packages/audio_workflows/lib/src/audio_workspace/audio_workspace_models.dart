enum AudioWorkspaceProcessingState {
  modelMissing,
  installing,
  queued,
  preparing,
  asr,
  diarization,
  partialSuccess,
  completed,
  canceling,
  canceled,
  retryableFailure,
  terminalFailure,
  recoveryUnknown;

  static AudioWorkspaceProcessingState fromStorage({
    required String status,
    required String stage,
  }) {
    return switch (stage) {
      'model_missing' => modelMissing,
      'installing' => installing,
      'preparing' => preparing,
      'asr' => asr,
      'diarization' => diarization,
      'partial_success' => partialSuccess,
      'canceling' => canceling,
      'retryable_failure' || 'startup_reconciliation' => retryableFailure,
      'terminal_failure' => terminalFailure,
      'recovery_unknown' => recoveryUnknown,
      _ => switch (status) {
        'pending' => queued,
        'processing' => preparing,
        'completed' => completed,
        'canceled' => canceled,
        'failed' => retryableFailure,
        _ => recoveryUnknown,
      },
    };
  }
}

enum AudioWorkspaceReviewState {
  unreviewed,
  needsReview,
  reviewed;

  static AudioWorkspaceReviewState fromStorage(String value) => switch (value) {
    'reviewed' => reviewed,
    'needs_review' => needsReview,
    _ => unreviewed,
  };

  String get storageValue => switch (this) {
    unreviewed => 'unreviewed',
    needsReview => 'needs_review',
    reviewed => 'reviewed',
  };
}

enum AudioWorkspaceSpeakerState { assigned, overlap, unknown }

class AudioWorkspaceSummary {
  const AudioWorkspaceSummary({
    required this.recordingId,
    required this.displayName,
    required this.filePath,
    required this.durationMs,
    required this.createdAtMs,
    required this.processingState,
    this.generationId,
    this.segmentCount = 0,
  });

  final int recordingId;
  final String displayName;
  final String filePath;
  final int durationMs;
  final int createdAtMs;
  final int? generationId;
  final int segmentCount;
  final AudioWorkspaceProcessingState processingState;
}

class AudioWorkspaceSpeaker {
  const AudioWorkspaceSpeaker({
    required this.id,
    required this.stableKey,
    required this.displayName,
    required this.source,
    required this.mergedIntoSpeakerId,
  });

  final int id;
  final String stableKey;
  final String displayName;
  final String source;
  final int? mergedIntoSpeakerId;
}

class AudioWorkspaceSegment {
  const AudioWorkspaceSegment({
    required this.id,
    required this.sequenceId,
    required this.text,
    required this.startMs,
    required this.endMs,
    required this.reviewState,
    required this.speakerState,
    this.speakerId,
    this.speakerName,
    this.speakerSource,
  });

  final int id;
  final int sequenceId;
  final String text;
  final int startMs;
  final int endMs;
  final AudioWorkspaceReviewState reviewState;
  final AudioWorkspaceSpeakerState speakerState;
  final int? speakerId;
  final String? speakerName;
  final String? speakerSource;

  bool get hasManualSpeakerAssignment => speakerSource == 'manual';
}

class AudioWorkspaceInsight {
  const AudioWorkspaceInsight({
    required this.id,
    required this.kind,
    required this.body,
    required this.status,
    required this.evidenceSegmentIds,
    this.actionOwner,
    this.actionDueAtMs,
  });

  final int id;
  final String kind;
  final String body;
  final String status;
  final List<int> evidenceSegmentIds;
  final String? actionOwner;
  final int? actionDueAtMs;
}

class AudioWorkspaceSnapshot {
  const AudioWorkspaceSnapshot({
    required this.summary,
    required this.segments,
    required this.speakers,
    required this.insights,
    required this.canUndo,
    required this.canRedo,
  });

  final AudioWorkspaceSummary summary;
  final List<AudioWorkspaceSegment> segments;
  final List<AudioWorkspaceSpeaker> speakers;
  final List<AudioWorkspaceInsight> insights;
  final bool canUndo;
  final bool canRedo;
}

enum AudioWorkspaceExportFormat { text, markdown, webVtt, srt, json }

class AudioWorkspaceExport {
  const AudioWorkspaceExport({
    required this.format,
    required this.fileExtension,
    required this.mimeType,
    required this.contents,
  });

  final AudioWorkspaceExportFormat format;
  final String fileExtension;
  final String mimeType;
  final String contents;
}
