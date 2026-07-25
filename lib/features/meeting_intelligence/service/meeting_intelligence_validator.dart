import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_insight_entity.dart';
import 'meeting_intelligence_provider.dart';

class ValidatedMeetingInsight {
  const ValidatedMeetingInsight({
    required this.candidate,
    required this.unsupported,
    required this.unresolvedOwner,
    required this.unresolvedDueDate,
  });

  final MeetingInsightCandidate candidate;
  final bool unsupported;
  final bool unresolvedOwner;
  final bool unresolvedDueDate;
}

class ValidatedMeetingIntelligence {
  const ValidatedMeetingIntelligence({required this.items});

  final List<ValidatedMeetingInsight> items;
}

class MeetingIntelligenceValidator {
  const MeetingIntelligenceValidator();

  ValidatedMeetingIntelligence validate({
    required MeetingIntelligenceRequest request,
    required MeetingIntelligenceOutput output,
  }) {
    if (request.inputStartMs < 0 ||
        request.inputEndMs <= request.inputStartMs) {
      throw const FormatException('会议智能输入时间范围无效');
    }
    final segments = <int, TranscriptSegmentEntity>{
      for (final segment in request.segments) segment.id: segment,
    };
    final items = <ValidatedMeetingInsight>[];
    for (final candidate in output.items) {
      if (candidate.body.trim().isEmpty) {
        throw const FormatException('会议智能条目正文不能为空');
      }
      for (final evidence in candidate.evidence) {
        final segment = segments[evidence.segmentId];
        if (segment == null ||
            segment.generationId != request.generationId ||
            segment.recordingId != request.recordingId) {
          throw FormatException('证据片段 ${evidence.segmentId} 不存在于当前会议');
        }
        if (evidence.startMs < segment.startMs ||
            evidence.endMs > segment.endMs ||
            evidence.endMs <= evidence.startMs) {
          throw FormatException('证据范围超出片段 ${segment.id}');
        }
        if (evidence.startMs < request.inputStartMs ||
            evidence.endMs > request.inputEndMs) {
          throw const FormatException('证据范围超出提供商输入范围');
        }
      }
      final actionKind = candidate.kind == MeetingInsightKind.action;
      items.add(
        ValidatedMeetingInsight(
          candidate: candidate,
          unsupported: candidate.evidence.isEmpty,
          unresolvedOwner:
              actionKind && (candidate.actionOwner?.trim().isEmpty ?? true),
          unresolvedDueDate: actionKind && candidate.actionDueAtMs == null,
        ),
      );
    }
    return ValidatedMeetingIntelligence(items: items);
  }
}
