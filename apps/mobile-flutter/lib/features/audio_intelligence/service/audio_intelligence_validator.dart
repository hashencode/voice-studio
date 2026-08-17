import '../../transcription/model/transcript_segment_entity.dart';
import '../model/audio_insight_entity.dart';
import 'audio_intelligence_provider.dart';

class ValidatedAudioInsight {
  const ValidatedAudioInsight({
    required this.candidate,
    required this.unsupported,
    required this.unresolvedOwner,
    required this.unresolvedDueDate,
  });

  final AudioInsightCandidate candidate;
  final bool unsupported;
  final bool unresolvedOwner;
  final bool unresolvedDueDate;
}

class ValidatedAudioIntelligence {
  const ValidatedAudioIntelligence({
    required this.items,
    this.schemaVersion = 'audio_intelligence_output/v1',
    this.audioType,
    this.suggestedTitle,
  });

  final List<ValidatedAudioInsight> items;
  final String schemaVersion;
  final String? audioType;
  final String? suggestedTitle;
}

class AudioIntelligenceValidator {
  const AudioIntelligenceValidator();

  ValidatedAudioIntelligence validate({
    required AudioIntelligenceRequest request,
    required AudioIntelligenceOutput output,
  }) {
    if (request.inputStartMs < 0 ||
        request.inputEndMs <= request.inputStartMs) {
      throw const FormatException('音频智能输入时间范围无效');
    }
    final segments = <int, TranscriptSegmentEntity>{
      for (final segment in request.segments) segment.id: segment,
    };
    final items = <ValidatedAudioInsight>[];
    if (output.schemaVersion != 'audio_intelligence_output/v1') {
      throw FormatException('不支持的音频智能输出版本：${output.schemaVersion}');
    }
    for (final candidate in output.items) {
      if (candidate.body.trim().isEmpty) {
        throw const FormatException('音频智能条目正文不能为空');
      }
      var invalidEvidence = false;
      final validEvidence = <AudioEvidenceCandidate>[];
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
      final actionKind = candidate.kind == AudioInsightKind.action;
      final sanitizedCandidate = AudioInsightCandidate(
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
        ValidatedAudioInsight(
          candidate: sanitizedCandidate,
          unsupported: invalidEvidence || validEvidence.isEmpty,
          unresolvedOwner:
              actionKind && (candidate.actionOwner?.trim().isEmpty ?? true),
          unresolvedDueDate: actionKind && candidate.actionDueAtMs == null,
        ),
      );
    }
    return ValidatedAudioIntelligence(
      items: items,
      schemaVersion: output.schemaVersion,
      audioType: output.audioType?.trim().isEmpty == true
          ? null
          : output.audioType?.trim(),
      suggestedTitle: output.suggestedTitle?.trim().isEmpty == true
          ? null
          : output.suggestedTitle?.trim(),
    );
  }
}
