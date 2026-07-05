import 'dart:async';

import 'realtime_transcription_event.dart';
import 'realtime_transcription_events_port.dart';

class FakeRealtimeTranscriptionEvents
    implements RealtimeTranscriptionEventsPort {
  final StreamController<RealtimeTranscriptionEvent> _controller =
      StreamController<RealtimeTranscriptionEvent>.broadcast();

  @override
  Stream<RealtimeTranscriptionEvent> watch() => _controller.stream;

  void emit(RealtimeTranscriptionEvent event) {
    if (!_controller.isClosed) {
      _controller.add(event);
    }
  }

  void emitSegment({
    required String recordingPath,
    required int sequenceId,
    required String text,
    required int startMs,
    required int endMs,
  }) {
    emit(
      RealtimeTranscriptionEvent.segment(
        recordingPath: recordingPath,
        sequenceId: sequenceId,
        text: text,
        startMs: startMs,
        endMs: endMs,
      ),
    );
  }

  void emitDegradation({
    required String recordingPath,
    required String reason,
  }) {
    emit(
      RealtimeTranscriptionEvent.degradation(
        recordingPath: recordingPath,
        reason: reason,
      ),
    );
  }

  @override
  void dispose() {
    _controller.close();
  }
}
