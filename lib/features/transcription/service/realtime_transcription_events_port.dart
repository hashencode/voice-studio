import 'realtime_transcription_event.dart';

abstract class RealtimeTranscriptionEventsPort {
  Stream<RealtimeTranscriptionEvent> watch();
  void dispose() {}
}
