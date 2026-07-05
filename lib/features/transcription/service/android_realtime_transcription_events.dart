import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import 'realtime_transcription_event.dart';
import 'realtime_transcription_events_port.dart';

class AndroidRealtimeTranscriptionEvents
    implements RealtimeTranscriptionEventsPort {
  AndroidRealtimeTranscriptionEvents()
    : _channel = const EventChannel(AudioContract.transcriptionEventsChannel);

  final EventChannel _channel;

  @override
  Stream<RealtimeTranscriptionEvent> watch() {
    return _channel.receiveBroadcastStream().map((Object? payload) {
      if (payload is Map<Object?, Object?>) {
        return RealtimeTranscriptionEvent.fromPayload(payload);
      }
      return RealtimeTranscriptionEvent.malformed(payload);
    });
  }

  @override
  void dispose() {}
}
