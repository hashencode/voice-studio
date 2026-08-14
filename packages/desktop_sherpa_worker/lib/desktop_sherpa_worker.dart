library;

export 'package:processing_contracts/processing_contracts.dart'
    show
        SherpaDesktopModelSet,
        ProcessingOperationalEnvelope,
        frozenQwen3Hotwords,
        frozenQwen3MaximumSpeechSeconds,
        frozenQwen3MaxNewTokens,
        frozenQwen3MaxTotalLen,
        frozenQwen3MinimumSilenceSeconds,
        frozenQwen3MinimumSpeechSeconds,
        frozenQwen3Seed,
        frozenQwen3SegmentDurationSeconds,
        frozenQwen3Segmentation,
        frozenQwen3Temperature,
        frozenQwen3TopP,
        frozenQwen3VadThreshold,
        frozenQwen3VadWindowSize,
        validateFrozenQwen3ProductProfile;

export 'src/qwen3_result.dart';
export 'src/sherpa_desktop_processing_engine.dart';
export 'src/sherpa_runtime_probe.dart';
export 'src/worker_health_contract.dart';
