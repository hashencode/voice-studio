import 'dart:io';

const int frozenQwen3MaxTotalLen = 512;
const int frozenQwen3MaxNewTokens = 512;
const double frozenQwen3Temperature = 0.000001;
const double frozenQwen3TopP = 0.8;
const int frozenQwen3Seed = 42;
const String frozenQwen3Hotwords = '';
const int frozenQwen3SegmentDurationSeconds = 15;
const String frozenQwen3Segmentation = 'official_silero_vad';
const double frozenQwen3VadThreshold = 0.2;
const double frozenQwen3MinimumSpeechSeconds = 0.2;
const double frozenQwen3MaximumSpeechSeconds = 12;
const double frozenQwen3MinimumSilenceSeconds = 0.5;
const int frozenQwen3VadWindowSize = 512;

void validateFrozenQwen3ProductProfile({
  required int numThreads,
  required int maxTotalLen,
  required int maxNewTokens,
  required double temperature,
  required double topP,
  required int seed,
  required String hotwords,
  required int segmentDurationSeconds,
  required String segmentation,
  required double vadThreshold,
  required double minimumSpeechSeconds,
  required double maximumSpeechSeconds,
}) {
  if (numThreads != 2 ||
      maxTotalLen != frozenQwen3MaxTotalLen ||
      maxNewTokens != frozenQwen3MaxNewTokens ||
      temperature != frozenQwen3Temperature ||
      topP != frozenQwen3TopP ||
      seed != frozenQwen3Seed ||
      hotwords != frozenQwen3Hotwords ||
      segmentDurationSeconds != frozenQwen3SegmentDurationSeconds ||
      segmentation != frozenQwen3Segmentation ||
      vadThreshold != frozenQwen3VadThreshold ||
      minimumSpeechSeconds != frozenQwen3MinimumSpeechSeconds ||
      maximumSpeechSeconds != frozenQwen3MaximumSpeechSeconds) {
    throw const FormatException('Qwen3 product profile is not frozen');
  }
}

class SherpaDesktopModelSet {
  const SherpaDesktopModelSet({
    required this.convFrontendPath,
    required this.encoderPath,
    required this.decoderPath,
    required this.tokenizerPath,
    required this.vadPath,
    required this.segmentationPath,
    required this.embeddingPath,
  });

  final String convFrontendPath;
  final String encoderPath;
  final String decoderPath;
  final String tokenizerPath;
  final String vadPath;
  final String segmentationPath;
  final String embeddingPath;

  bool get allFilesPresent =>
      <String>[
        convFrontendPath,
        encoderPath,
        decoderPath,
        vadPath,
        segmentationPath,
        embeddingPath,
      ].every((path) => File(path).existsSync()) &&
      Directory(tokenizerPath).existsSync();
}
