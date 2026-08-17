import 'audio_workspace_models.dart';

abstract interface class AudioWorkspacePort {
  Future<List<AudioWorkspaceSummary>> listAudios({
    String query = '',
    int limit = 200,
    int offset = 0,
  });

  Future<AudioWorkspaceSnapshot?> openAudio(int recordingId);

  Future<List<AudioWorkspaceSegment>> searchTranscript({
    required int recordingId,
    required String query,
    int? startMs,
    int? endMs,
    int? speakerId,
    int limit = 200,
  });

  Future<bool> saveSegment({
    required int segmentId,
    required String text,
    required AudioWorkspaceReviewState reviewState,
  });

  Future<bool> undo(int generationId);

  Future<bool> redo(int generationId);

  Future<void> renameSpeakers(Map<int, String> names);

  Future<void> mergeSpeakers({
    required int generationId,
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  });

  Future<void> assignSpeaker({
    required int generationId,
    required int segmentId,
    required int? speakerId,
    required AudioWorkspaceSpeakerState state,
  });
}
