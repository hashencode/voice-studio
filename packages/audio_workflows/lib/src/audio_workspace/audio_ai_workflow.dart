import '../audio_intelligence/audio_ai_provider.dart';
import 'audio_workspace_models.dart';

class AudioAiWorkflow {
  const AudioAiWorkflow({required AudioAiProviderPort? provider})
    : _provider = provider;

  final AudioAiProviderPort? _provider;

  Future<AudioAiOutput> generate(AudioAiRequest request) async {
    final provider = _provider;
    if (provider == null) {
      throw const AudioAiFailure(
        AudioAiFailureCode.providerMissing,
        '未配置音频智能提供商',
      );
    }
    final descriptor = audioAiDescriptorOf(provider);
    if (descriptor.requiresAudioConsent &&
        request.consent != AudioAiConsent.granted) {
      throw const AudioAiFailure(
        AudioAiFailureCode.consentRequired,
        '需要针对本次音频明确同意发送转写文本',
      );
    }
    if (!await provider.isConfigured()) {
      throw AudioAiFailure(
        AudioAiFailureCode.secretMissing,
        descriptor.requiresSecret ? '请先配置提供商密钥' : '提供商配置不完整',
      );
    }
    if (request.recordingId <= 0 ||
        request.generationId <= 0 ||
        request.segments.isEmpty) {
      throw const AudioAiFailure(AudioAiFailureCode.invalidOutput, '音频转写尚未准备好');
    }
    final output = await provider.generate(request);
    _validate(output, request.segments);
    return output;
  }

  void _validate(AudioAiOutput output, List<AudioWorkspaceSegment> segments) {
    if (output.schemaVersion != 'audio_intelligence_output/v1' ||
        output.insights.length > 200) {
      throw const AudioAiFailure(AudioAiFailureCode.invalidOutput, '云端结果结构无效');
    }
    final byId = {for (final segment in segments) segment.id: segment};
    for (final insight in output.insights) {
      if (insight.kind.trim().isEmpty ||
          insight.body.trim().isEmpty ||
          insight.body.runes.length > 4000 ||
          insight.evidence.length > 20) {
        throw const AudioAiFailure(
          AudioAiFailureCode.invalidOutput,
          '云端结果包含无效条目',
        );
      }
      for (final evidence in insight.evidence) {
        final segment = byId[evidence.segmentId];
        if (segment == null ||
            evidence.startMs < segment.startMs ||
            evidence.endMs > segment.endMs ||
            evidence.endMs <= evidence.startMs) {
          throw const AudioAiFailure(
            AudioAiFailureCode.invalidOutput,
            '云端结果包含无效证据引用',
          );
        }
      }
    }
  }
}
