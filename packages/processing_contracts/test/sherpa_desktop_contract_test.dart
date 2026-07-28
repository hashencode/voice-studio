import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  test('accepts only the frozen Qwen3 product profile', () {
    expect(
      () => validateFrozenQwen3ProductProfile(
        numThreads: 2,
        maxTotalLen: frozenQwen3MaxTotalLen,
        maxNewTokens: frozenQwen3MaxNewTokens,
        temperature: frozenQwen3Temperature,
        topP: frozenQwen3TopP,
        seed: frozenQwen3Seed,
        hotwords: frozenQwen3Hotwords,
        segmentDurationSeconds: frozenQwen3SegmentDurationSeconds,
        segmentation: frozenQwen3Segmentation,
        vadThreshold: frozenQwen3VadThreshold,
        minimumSpeechSeconds: frozenQwen3MinimumSpeechSeconds,
        maximumSpeechSeconds: frozenQwen3MaximumSpeechSeconds,
      ),
      returnsNormally,
    );

    expect(
      () => validateFrozenQwen3ProductProfile(
        numThreads: 4,
        maxTotalLen: frozenQwen3MaxTotalLen,
        maxNewTokens: frozenQwen3MaxNewTokens,
        temperature: frozenQwen3Temperature,
        topP: frozenQwen3TopP,
        seed: frozenQwen3Seed,
        hotwords: frozenQwen3Hotwords,
        segmentDurationSeconds: frozenQwen3SegmentDurationSeconds,
        segmentation: 'fixed',
        vadThreshold: frozenQwen3VadThreshold,
        minimumSpeechSeconds: frozenQwen3MinimumSpeechSeconds,
        maximumSpeechSeconds: frozenQwen3MaximumSpeechSeconds,
      ),
      throwsFormatException,
    );
  });
}
