import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/deepseek_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_output_codec.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  test('rotated-key fictional one-request smoke', () async {
    final secret = Platform.environment['DEEPSEEK_API_KEY'];
    if (secret == null || secret.isEmpty) {
      fail('Rotated DEEPSEEK_API_KEY is required.');
    }
    final provider = DeepSeekMeetingIntelligenceProvider(
      modelId: 'deepseek-v4-flash',
      secretLoader: () async => secret,
      maximumOutputTokens: 512,
    );
    final output = await provider.generate(
      MeetingIntelligenceRequest(
        recordingId: 1,
        generationId: 1,
        processingLocation: MeetingProcessingLocation.cloudDirect,
        consentDecision: MeetingConsentDecision.granted,
        inputStartMs: 0,
        inputEndMs: 5000,
        segments: <TranscriptSegmentEntity>[
          TranscriptSegmentEntity(
            id: 1,
            recordingPath: '/fictional-not-created.wav',
            recordingId: 1,
            generationId: 1,
            jobId: null,
            sequenceId: 0,
            text: '虚构会议：团队决定下周检查演示稿，负责人和日期尚未确认。',
            startMs: 0,
            endMs: 5000,
            isFinal: true,
            source: 'synthetic-smoke',
            confidence: null,
            createdAtMs: 1,
            updatedAtMs: 1,
          ),
        ],
        consentAtMs: DateTime.now().millisecondsSinceEpoch,
        payloadSummary: '1 个虚构转写片段，00:00–00:05，预计 1 次请求',
      ),
    );

    expect(output.schemaVersion, MeetingIntelligenceOutputCodec.schemaVersion);
  });
}
