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
  const ValidatedMeetingIntelligence({
    required this.items,
    this.schemaVersion = 'meeting_intelligence_output/v1',
    this.meetingType,
    this.suggestedTitle,
  });

  final List<ValidatedMeetingInsight> items;
  final String schemaVersion;
  final String? meetingType;
  final String? suggestedTitle;
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
    if (output.schemaVersion != 'meeting_intelligence_output/v1') {
      throw FormatException('不支持的会议智能输出版本：${output.schemaVersion}');
    }
    for (final candidate in output.items) {
      if (candidate.body.trim().isEmpty) {
        throw const FormatException('会议智能条目正文不能为空');
      }
      var invalidEvidence = false;
      final validEvidence = <MeetingEvidenceCandidate>[];
      for (final evidence in candidate.evidence) {
        final segment = segments[evidence.segmentId];
        if (segment == null ||
            segment.generationId != request.generationId ||
            segment.recordingId != request.recordingId) {
          invalidEvidence = true;
          continue;
        } else if (evidence.startMs < segment.startMs ||
            evidence.endMs > segment.endMs ||
            evidence.endMs <= evidence.startMs) {
          invalidEvidence = true;
          continue;
        } else if (evidence.startMs < request.inputStartMs ||
            evidence.endMs > request.inputEndMs) {
          invalidEvidence = true;
          continue;
        }
        validEvidence.add(evidence);
      }
      if ((candidate.topicStartMs == null) != (candidate.topicEndMs == null)) {
        throw const FormatException('议题时间范围必须同时包含开始和结束');
      }
      if (candidate.topicStartMs != null &&
          (candidate.topicStartMs! < request.inputStartMs ||
              candidate.topicEndMs! > request.inputEndMs ||
              candidate.topicEndMs! <= candidate.topicStartMs!)) {
        throw const FormatException('议题时间范围超出提供商输入范围');
      }
      final actionKind = candidate.kind == MeetingInsightKind.action;
      final sanitizedCandidate = MeetingInsightCandidate(
        kind: candidate.kind,
        body: candidate.body.trim(),
        evidence: validEvidence,
        actionOwner: candidate.actionOwner?.trim(),
        actionDueAtMs: candidate.actionDueAtMs,
        resolutionState: candidate.resolutionState,
        topicStartMs: candidate.topicStartMs,
        topicEndMs: candidate.topicEndMs,
        sortOrder: candidate.sortOrder,
      );
      items.add(
        ValidatedMeetingInsight(
          candidate: sanitizedCandidate,
          unsupported: invalidEvidence || validEvidence.isEmpty,
          unresolvedOwner:
              actionKind && (candidate.actionOwner?.trim().isEmpty ?? true),
          unresolvedDueDate: actionKind && candidate.actionDueAtMs == null,
        ),
      );
    }
    return ValidatedMeetingIntelligence(
      items: items,
      schemaVersion: output.schemaVersion,
      meetingType: output.meetingType?.trim().isEmpty == true
          ? null
          : output.meetingType?.trim(),
      suggestedTitle: output.suggestedTitle?.trim().isEmpty == true
          ? null
          : output.suggestedTitle?.trim(),
    );
  }
}
