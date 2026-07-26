import 'package:meeting_core/meeting_core.dart';

abstract interface class MeetingMediaImportPort {
  bool get isAvailable;

  Stream<void> get sharedMediaAvailable;

  Future<bool> hasPendingSharedImport();

  Future<MeetingMediaCandidate?> pickMeetingMedia();

  Future<MeetingMediaCandidate?> consumeSharedMeetingMedia();

  Future<void> cancelImport();

  Future<void> discardImportedMedia(String path);

  void dispose();
}
