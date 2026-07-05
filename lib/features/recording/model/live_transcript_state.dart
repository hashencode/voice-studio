import '../../transcription/service/realtime_transcription_event.dart';

class LiveTranscriptState {
  LiveTranscriptState({
    required Map<int, RealtimeTranscriptionEvent> segments,
    this.degradationReason,
  }) : _segments = Map<int, RealtimeTranscriptionEvent>.unmodifiable(segments);

  factory LiveTranscriptState.empty() {
    return LiveTranscriptState(
      segments: const <int, RealtimeTranscriptionEvent>{},
    );
  }

  final Map<int, RealtimeTranscriptionEvent> _segments;
  final String? degradationReason;

  bool get hasSegments => _segments.isNotEmpty;
  bool get hasDegradation => degradationReason?.trim().isNotEmpty == true;

  List<RealtimeTranscriptionEvent> get orderedSegments {
    final List<RealtimeTranscriptionEvent> items = _segments.values.toList();
    items.sort((RealtimeTranscriptionEvent a, RealtimeTranscriptionEvent b) {
      final int bySequence = a.sequenceId.compareTo(b.sequenceId);
      if (bySequence != 0) return bySequence;
      return a.startMs.compareTo(b.startMs);
    });
    return items;
  }

  String get mergedText {
    return orderedSegments
        .where(
          (RealtimeTranscriptionEvent event) => event.text.trim().isNotEmpty,
        )
        .map((RealtimeTranscriptionEvent event) => event.text.trim())
        .join('\n');
  }

  LiveTranscriptState apply(RealtimeTranscriptionEvent event) {
    if (event.isSegment && event.sequenceId >= 0) {
      final Map<int, RealtimeTranscriptionEvent> next =
          <int, RealtimeTranscriptionEvent>{..._segments};
      next[event.sequenceId] = event;
      return LiveTranscriptState(
        segments: next,
        degradationReason: degradationReason,
      );
    }

    if (event.isDegradation) {
      return LiveTranscriptState(
        segments: _segments,
        degradationReason: event.reason ?? '实时转写已降级',
      );
    }

    return this;
  }
}
