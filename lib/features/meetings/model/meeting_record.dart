import '../../records/model/recording_entity.dart';
import '../../recording/model/recording_annotation_entity.dart';
import '../../transcription/model/transcript_generation_entity.dart';
import '../../transcription/model/transcript_segment_entity.dart';
import '../../transcription/model/transcription_job_entity.dart';

class MeetingRecord {
  const MeetingRecord({
    required this.recording,
    required this.generation,
    required this.segments,
    required this.latestJob,
    this.annotations = const <RecordingAnnotationEntity>[],
  });

  final RecordingEntity recording;
  final TranscriptGenerationEntity? generation;
  final List<TranscriptSegmentEntity> segments;
  final TranscriptionJobEntity? latestJob;
  final List<RecordingAnnotationEntity> annotations;

  String get title {
    final displayName = recording.displayName?.trim();
    if (displayName != null && displayName.isNotEmpty) return displayName;
    final sourceName = recording.sourceDisplayName?.trim();
    if (sourceName != null && sourceName.isNotEmpty) return sourceName;
    return '会议 ${recording.id}';
  }
}
