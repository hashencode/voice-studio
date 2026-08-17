import 'package:audio_core/audio_core.dart';

abstract interface class AudioMediaImportPort {
  bool get isAvailable;

  Stream<void> get sharedMediaAvailable;

  Future<bool> hasPendingSharedImport();

  Future<AudioMediaCandidate?> pickAudioMedia();

  Future<AudioMediaCandidate?> consumeSharedAudioMedia();

  Future<void> cancelImport();

  Future<void> discardImportedMedia(String path);

  void dispose();
}
