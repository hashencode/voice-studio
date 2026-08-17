import 'package:flutter/services.dart';

import '../../../app/contracts/audio_contract.dart';
import '../model/transcription_result.dart';
import 'transcription_port.dart';

class AndroidTranscriptionService implements TranscriptionPort {
  AndroidTranscriptionService({
    MethodChannel? methodChannel,
    EventChannel? eventChannel,
  }) : _channel = methodChannel ?? const MethodChannel(_channelName),
       _eventChannel =
           eventChannel ??
           const EventChannel(AudioContract.transcriptionEventChannel);

  static const String _channelName = AudioContract.recorderChannel;
  final MethodChannel _channel;
  final EventChannel _eventChannel;

  late final Stream<TranscriptionProgressEvent> _progressEvents = _eventChannel
      .receiveBroadcastStream()
      .where((event) => event is Map)
      .map(
        (event) => TranscriptionProgressEvent.fromMap(
          Map<Object?, Object?>.from(event as Map),
        ),
      )
      .asBroadcastStream();

  @override
  Stream<TranscriptionProgressEvent> get progressEvents => _progressEvents;

  @override
  Future<TranscriptionResult> transcribe(
    TranscriptionRequest request, {
    int jobId = 0,
  }) async {
    try {
      final raw = await _channel.invokeMethod<Object?>('transcribe', {
        'jobId': jobId,
        'recordingPath': request.recordingPath,
        'durationMs': request.durationMs,
        'modelId': request.modelId,
        'sampleRateHz': request.sampleRateHz,
        'enablePunctuation': request.enablePunctuation,
        'enableDenoise': request.enableDenoise,
        'attemptCount': request.attemptCount,
      });
      if (raw is! Map) {
        throw const TranscriptionFailure(
          code: 'EMPTY_RESULT',
          stage: 'decode',
          message: '原生转写未返回结构化结果',
        );
      }
      try {
        return TranscriptionResult.fromMap(Map<Object?, Object?>.from(raw));
      } on FormatException catch (error) {
        throw TranscriptionFailure(
          code: 'INVALID_RESULT',
          stage: 'decode',
          message: error.message,
        );
      }
    } on PlatformException catch (error) {
      if (error.code == 'CANCELED') {
        throw const TranscriptionCanceledException();
      }
      final details = error.details;
      final stage = details is Map
          ? details['stage'] as String? ?? 'unknown'
          : 'unknown';
      throw TranscriptionFailure(
        code: error.code,
        stage: stage,
        message: error.message ?? '原生转写失败',
      );
    }
  }

  @override
  Future<void> cancel(int jobId) async {
    await _channel.invokeMethod<void>(
      'cancelTranscriptionJob',
      <String, Object?>{'jobId': jobId},
    );
  }

  @override
  Future<Set<int>> activeJobIds() async {
    final values = await _channel.invokeListMethod<int>(
      'getActiveTranscriptionJobIds',
    );
    return values?.toSet() ?? const <int>{};
  }
}
