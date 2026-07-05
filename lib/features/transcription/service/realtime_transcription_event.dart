import '../../../app/contracts/audio_contract.dart';

enum RealtimeTranscriptionEventType {
  segment,
  degradation,
  sessionStarted,
  sessionStopped,
  unknown,
}

class RealtimeTranscriptionEvent {
  RealtimeTranscriptionEvent({
    required this.type,
    required this.recordingPath,
    required this.sequenceId,
    required this.text,
    required this.startMs,
    required this.endMs,
    required this.isFinal,
    required this.source,
    this.sessionId,
    this.jobId,
    this.confidence,
    this.reason,
  });

  final RealtimeTranscriptionEventType type;
  final String recordingPath;
  final int sequenceId;
  final String text;
  final int startMs;
  final int endMs;
  final bool isFinal;
  final String source;
  final String? sessionId;
  final int? jobId;
  final double? confidence;
  final String? reason;

  bool get isSegment => type == RealtimeTranscriptionEventType.segment;
  bool get isDegradation => type == RealtimeTranscriptionEventType.degradation;

  factory RealtimeTranscriptionEvent.segment({
    required String recordingPath,
    required int sequenceId,
    required String text,
    required int startMs,
    required int endMs,
    String source = 'realtime',
    String? sessionId,
    int? jobId,
    double? confidence,
    bool isFinal = true,
  }) {
    return RealtimeTranscriptionEvent(
      type: RealtimeTranscriptionEventType.segment,
      recordingPath: recordingPath,
      sequenceId: sequenceId,
      text: text,
      startMs: startMs,
      endMs: endMs,
      isFinal: isFinal,
      source: source,
      sessionId: sessionId,
      jobId: jobId,
      confidence: confidence,
    );
  }

  factory RealtimeTranscriptionEvent.degradation({
    required String recordingPath,
    required String reason,
    String? sessionId,
  }) {
    return RealtimeTranscriptionEvent(
      type: RealtimeTranscriptionEventType.degradation,
      recordingPath: recordingPath,
      sequenceId: -1,
      text: '',
      startMs: 0,
      endMs: 0,
      isFinal: true,
      source: 'realtime',
      sessionId: sessionId,
      reason: reason,
    );
  }

  static RealtimeTranscriptionEvent fromPayload(Map<Object?, Object?> payload) {
    final String type = payload['type'] as String? ?? '';
    return RealtimeTranscriptionEvent(
      type: _parseType(type),
      recordingPath: payload['recordingPath'] as String? ?? '',
      sequenceId: _readInt(payload['sequenceId'], fallback: -1),
      text: payload['text'] as String? ?? '',
      startMs: _readInt(payload['startMs']),
      endMs: _readInt(payload['endMs']),
      isFinal: payload['isFinal'] as bool? ?? true,
      source: payload['source'] as String? ?? 'realtime',
      sessionId: payload['sessionId'] as String?,
      jobId: payload['jobId'] == null
          ? null
          : _readInt(payload['jobId'], fallback: 0),
      confidence: (payload['confidence'] as num?)?.toDouble(),
      reason: payload['reason'] as String?,
    );
  }

  static RealtimeTranscriptionEvent malformed(Object? payload) {
    return RealtimeTranscriptionEvent(
      type: RealtimeTranscriptionEventType.unknown,
      recordingPath: '',
      sequenceId: -1,
      text: '',
      startMs: 0,
      endMs: 0,
      isFinal: true,
      source: 'realtime',
      reason: '实时事件格式无法解析: ${payload.runtimeType}',
    );
  }

  Map<String, Object?> toPayload() {
    return <String, Object?>{
      'type': _typeName(type),
      'recordingPath': recordingPath,
      'sequenceId': sequenceId,
      'text': text,
      'startMs': startMs,
      'endMs': endMs,
      'isFinal': isFinal,
      'source': source,
      'sessionId': sessionId,
      'jobId': jobId,
      'confidence': confidence,
      'reason': reason,
    };
  }

  static int _readInt(Object? value, {int fallback = 0}) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return fallback;
  }

  static RealtimeTranscriptionEventType _parseType(String type) {
    switch (type) {
      case AudioContract.eventTypeSegment:
        return RealtimeTranscriptionEventType.segment;
      case AudioContract.eventTypeDegradation:
        return RealtimeTranscriptionEventType.degradation;
      case AudioContract.eventTypeSessionStarted:
        return RealtimeTranscriptionEventType.sessionStarted;
      case AudioContract.eventTypeSessionStopped:
        return RealtimeTranscriptionEventType.sessionStopped;
      default:
        return RealtimeTranscriptionEventType.unknown;
    }
  }

  static String _typeName(RealtimeTranscriptionEventType type) {
    switch (type) {
      case RealtimeTranscriptionEventType.segment:
        return AudioContract.eventTypeSegment;
      case RealtimeTranscriptionEventType.degradation:
        return AudioContract.eventTypeDegradation;
      case RealtimeTranscriptionEventType.sessionStarted:
        return AudioContract.eventTypeSessionStarted;
      case RealtimeTranscriptionEventType.sessionStopped:
        return AudioContract.eventTypeSessionStopped;
      case RealtimeTranscriptionEventType.unknown:
        return 'unknown';
    }
  }
}
