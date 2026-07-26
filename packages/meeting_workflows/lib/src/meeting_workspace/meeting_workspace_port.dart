import 'meeting_workspace_models.dart';

abstract interface class MeetingWorkspacePort {
  Future<List<MeetingWorkspaceSummary>> listMeetings({
    String query = '',
    int limit = 200,
    int offset = 0,
  });

  Future<MeetingWorkspaceSnapshot?> openMeeting(int recordingId);

  Future<List<MeetingWorkspaceSegment>> searchTranscript({
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
    required MeetingWorkspaceReviewState reviewState,
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
    required MeetingWorkspaceSpeakerState state,
  });
}
