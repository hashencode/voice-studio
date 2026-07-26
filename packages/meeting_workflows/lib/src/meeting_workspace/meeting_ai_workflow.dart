import 'meeting_workspace_models.dart';

enum MeetingAiConsent { denied, granted }

enum MeetingAiFailureCode {
  providerMissing,
  secretMissing,
  consentRequired,
  invalidOutput,
  networkUnavailable,
  unauthorized,
  rateLimited,
  serviceUnavailable,
  canceled,
}

class MeetingAiFailure implements Exception {
  const MeetingAiFailure(this.code, this.message);

  final MeetingAiFailureCode code;
  final String message;

  @override
  String toString() => 'MeetingAiFailure(${code.name})';
}

class MeetingAiEvidence {
  const MeetingAiEvidence({
    required this.segmentId,
    required this.startMs,
    required this.endMs,
  });

  final int segmentId;
  final int startMs;
  final int endMs;
}

class MeetingAiInsight {
  const MeetingAiInsight({
    required this.kind,
    required this.body,
    required this.evidence,
    this.actionOwner,
    this.actionDueAtMs,
  });

  final String kind;
  final String body;
  final List<MeetingAiEvidence> evidence;
  final String? actionOwner;
  final int? actionDueAtMs;
}

class MeetingAiOutput {
  const MeetingAiOutput({
    required this.insights,
    this.schemaVersion = 'meeting_intelligence_output/v1',
    this.suggestedTitle,
    this.meetingType,
  });

  final String schemaVersion;
  final String? suggestedTitle;
  final String? meetingType;
  final List<MeetingAiInsight> insights;
}

class MeetingAiRequest {
  const MeetingAiRequest({
    required this.recordingId,
    required this.generationId,
    required this.consent,
    required this.segments,
    required this.meetingTitle,
    this.templateId = 'general',
  });

  final int recordingId;
  final int generationId;
  final MeetingAiConsent consent;
  final List<MeetingWorkspaceSegment> segments;
  final String meetingTitle;
  final String templateId;
}

abstract interface class MeetingAiProviderPort {
  String get providerId;
  String get modelId;

  Future<bool> isConfigured();

  Future<MeetingAiOutput> generate(MeetingAiRequest request);
}

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
    if (request.consent != MeetingAiConsent.granted) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.consentRequired,
        '需要针对本次会议明确同意发送转写文本',
      );
    }
    if (!await provider.isConfigured()) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.secretMissing,
        '请先在设置中输入云端密钥',
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
