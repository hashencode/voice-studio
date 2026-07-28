import '../meeting_intelligence/meeting_ai_provider.dart';
import 'meeting_workspace_models.dart';

class MeetingAiWorkflow {
  const MeetingAiWorkflow({required MeetingAiProviderPort? provider})
    : _provider = provider;

  final MeetingAiProviderPort? _provider;

  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    final provider = _provider;
    if (provider == null) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.providerMissing,
        '未配置会议智能提供商',
      );
    }
    final descriptor = meetingAiDescriptorOf(provider);
    if (descriptor.requiresMeetingConsent &&
        request.consent != MeetingAiConsent.granted) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.consentRequired,
        '需要针对本次会议明确同意发送转写文本',
      );
    }
    if (!await provider.isConfigured()) {
      throw MeetingAiFailure(
        MeetingAiFailureCode.secretMissing,
        descriptor.requiresSecret ? '请先配置提供商密钥' : '提供商配置不完整',
      );
    }
    if (request.recordingId <= 0 ||
        request.generationId <= 0 ||
        request.segments.isEmpty) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidOutput,
        '会议转写尚未准备好',
      );
    }
    final output = await provider.generate(request);
    _validate(output, request.segments);
    return output;
  }

  void _validate(
    MeetingAiOutput output,
    List<MeetingWorkspaceSegment> segments,
  ) {
    if (output.schemaVersion != 'meeting_intelligence_output/v1' ||
        output.insights.length > 200) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidOutput,
        '云端结果结构无效',
      );
    }
    final byId = {for (final segment in segments) segment.id: segment};
    for (final insight in output.insights) {
      if (insight.kind.trim().isEmpty ||
          insight.body.trim().isEmpty ||
          insight.body.runes.length > 4000 ||
          insight.evidence.length > 20) {
        throw const MeetingAiFailure(
          MeetingAiFailureCode.invalidOutput,
          '云端结果包含无效条目',
        );
      }
      for (final evidence in insight.evidence) {
        final segment = byId[evidence.segmentId];
        if (segment == null ||
            evidence.startMs < segment.startMs ||
            evidence.endMs > segment.endMs ||
            evidence.endMs <= evidence.startMs) {
          throw const MeetingAiFailure(
            MeetingAiFailureCode.invalidOutput,
            '云端结果包含无效证据引用',
          );
        }
      }
    }
  }
}
