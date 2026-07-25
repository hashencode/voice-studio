# S2 ASR Capability Review

Date: 2026-07-25

## Scope disposition

Decision `S2-MOBILE-CORE-2026-07-25` keeps Paraformer as the S2 Mobile Core
production baseline. Automatic confidence, decoder hotwords and advanced ITN
are future PC benchmark inputs; GTCRN/AEC is an advanced-audio input. The
candidate evidence below remains authoritative, but no historical BLOCKED/FAIL
result becomes PASS through the scope change.

## Production baseline

- Route: recorded file → 16 kHz mono WAV → Silero VAD → offline Paraformer → optional CT-Transformer punctuation.
- Model: `sherpa-onnx-paraformer-zh-int8-2025-10-07`.
- Runtime: official sherpa-onnx Android AAR v1.13.3.
- AAR SHA-256: `243ad797a3b6e75ebbeaf7a2ab4aec0777e7d71b730685abb762a120940b07b6`.
- Paraformer archive metadata SHA-256: `f30431419edcf2663e8fa487523376cb98500c64d17018bd2f1fbee0abcd93bc`.
- Enhancement asset SHA-256: `e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534`.
- Runtime license: sherpa-onnx is Apache-2.0. Individual model provenance and redistribution terms still need to be recorded separately before a new asset can satisfy a product gate.

The installed AAR and production result are authoritative. A configuration property or bundled file is evidence of a possible integration surface, not proof that the active model supports the capability.

The auditable candidate registry is
`benchmark/asr_model_candidates.json`. It separates runtime and model licenses,
pins downloadable artifacts and required files, requires low- and mid-device
evidence, and prevents a candidate from becoming `production_eligible` unless
all declared capabilities, all accuracy/timestamp/hotword/confidence/ITN/
RTF/memory/thermal/package gates, and both low-/mid-device reports are pinned
PASS evidence.

## Reproducible API probe

Extract `classes.jar` from `android/app/libs/sherpa-onnx.aar` and inspect these installed classes with `javap`:

- `OfflineRecognizerResult` exposes text, tokens, timestamps, language, emotion, event, and durations. It exposes no confidence, score, log probability, or token probability.
- `OfflineRecognizerConfig` exposes `hotwordsFile`, `hotwordsScore`, `ruleFsts`, and `ruleFars`.
- `OfflineSpeechDenoiser` exposes `run(float[], int)` and returns `DenoisedAudio`.
- `OfflineSpeechDenoiserModelConfig` exposes GTCRN and DPDFNet model configurations.

The Android physical-device production smoke additionally asserts that every segment produced by the current Paraformer route keeps `confidence == null`.

## Physical production probe

The production smoke passed on 2026-07-24 using the connected Xiaomi M2102J2SC (Android 13):

- instrumentation: `PunctuationModelSmokeTest.testKnownTextAndRepositoryWavUseRealModel`
- outcome: 1/1 passed
- model bytes: 75,519,198
- known-text recognition: 1,250 ms
- repository WAV recognition: 73,933 ms raw and 49,765 ms with punctuation
- output: 19 segments, all with `confidence == null`
- content SHA-256: `15ef3d6aef35b238d68d0f4165d032732487607ad62dbbc7c73b34764495d63c`
- measured heap: 5,808,792 Java bytes and 17,400,328 native bytes

This device is the existing mid-range physical reference, not a claim that the phone is a high-end benchmark target.

## Capability matrix

| Capability | Installed API | Bundled asset | Product path | Gate result | Reason | Next executable step |
| --- | --- | --- | --- | --- | --- | --- |
| ITN | `ruleFsts` and `ruleFars` configuration fields exist | No FST/FAR ITN asset | Guarded interface and golden contract implemented; production disabled | `available=false`, `verified=false` | `itn_asset_missing` | Identify a redistribution-safe deterministic asset, record its license, and run it against the committed golden fixture. |
| Confidence | Result transport can preserve nullable confidence, but `OfflineRecognizerResult` exposes no score | None | Production mapper writes `null`; manual review remains orthogonal | `available=false`, `verified=false` | `recognizer_confidence_unavailable` | Evaluate a runtime-plus-model candidate with a documented signal and independent calibration set. |
| Hotwords | Generic recognizer config has hotword fields | No hotword file or compatible transducer model | Active model is offline Paraformer with greedy decoding; request and UI expose no fake entry | `available=false`, `verified=false` | `paraformer_hotwords_unsupported` | Evaluate a transducer plus `modified_beam_search` with a paired manifest; do not treat post-correction as contextual biasing. |
| Enhancement | Installed AAR has offline GTCRN/DPDFNet denoiser APIs | Byte-identical official `gtcrn_simple.onnx`, MIT notice packaged | Processor, Xiaomi API/ABI smoke, and complete five-case mid-device paired run exist; production not integrated | `available=true`, `verified=false` | `enhancement_preregistered_gates_failed` | Revise the candidate/processor, rerun all failed Xiaomi gates, then add independent timestamps and a low-device run. |

## Online transducer screening result

The pinned
`sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` screening candidate was
run on the Xiaomi M2102J2SC through the installed AAR's
`OnlineRecognizer`. The upstream archive and its embedded Apache-2.0 model
declaration are pinned in the registry. The four int8 model files total
25,354,625 bytes.

On the fixed 300.655-second Chinese corpus:

- baseline: CER 4.931%, RTF 0.0780;
- `modified_beam_search` plus the preregistered hotword file at score 1.5:
  CER 4.734%, RTF 0.0994;
- token, timestamp, and `ysProbs` counts were equal (964 baseline, 966
  hotword), proving that the candidate API exposes aligned raw score and
  timestamp arrays;
- raw `ysProbs` ranged from -2.598 to -0.060. They are not presented as
  calibrated confidence;
- both preregistered target phrases were already at ceiling: 52 total hits
  with and without hotwords. The required target-hit improvement therefore
  failed even though the decoder output changed and global CER improved.

Raw physical report SHA-256:
`7b6c9f0f723d90d37b5de0bf01a9c03e9e3332694f80c54e0fc272a912c7b0c9`.
Evaluation report SHA-256:
`8170f11f4d6708b9c5ec50579326eee80e05d07b90866bda938b29076c5d216e`.
This candidate stays `lab_only`; no product model, request, persistence, or UI
path was added.

## Why the gates remain closed

### ITN

The generic API surface is present, but the repository contains no `assets/sherpa/itn/` directory, rule FST, or FAR archive. No deterministic transformation can be enabled until its asset source, redistribution rights, complete-token behavior, and ambiguity fixtures are established.

U2 now provides the fail-closed interface, structured `ITN_FAILED` stage, and golden/ambiguity fixture described in [`S2_ITN_BLOCKER.md`](S2_ITN_BLOCKER.md). Those integration artifacts do not change the closed product gate.

### Confidence

`RealSherpaTranscriptionEngine` maps every production VAD segment with `confidence = null`. The installed `OfflineRecognizerResult` provides no alternative score. A derived heuristic would not be a model confidence signal and cannot satisfy ASR-006.

The online screening candidate exposes raw per-token scores, but this fixed
corpus produced only deletions relative to the reference. Every emitted token
therefore aligned as correct and there was no negative emitted-token class for
threshold calibration. Independent calibration and held-out validation remain
missing. U3's conclusion is recorded in
[`S2_CONFIDENCE_REVIEW.md`](S2_CONFIDENCE_REVIEW.md).

### Hotwords

Sherpa's official contextual-biasing documentation limits hotwords to transducer models using `modified_beam_search`. The production model is Paraformer, so the presence of `hotwordsFile` in a generic config class does not make hotwords available.

The isolated online transducer run proves that a real decoder-stage path can
change output, but it did not improve the preregistered target-term hit rate.
U4's decoder and product-contract conclusion is recorded in
[`S2_HOTWORD_BLOCKER.md`](S2_HOTWORD_BLOCKER.md).

### Enhancement

The candidate is now identified as the official MIT-licensed
`gtcrn_simple.onnx`, and the Xiaomi API/ABI smoke passed at RTF 0.0778. The
complete five-case paired Xiaomi run then failed quiet CER regression
(+0.8876 percentage points vs +0.5 allowed), mean noisy-CER improvement
(+0.2301 points vs +5 required), enhancement RTF (0.3273 vs 0.25), native
heap delta (349,676,096 vs 134,217,728 bytes), and paired-boundary comparison
(only 3/5 comparable, maximum P95 616 ms vs 250). Independent absolute
timestamps and the low-device run remain missing, and there is no AEC. See
[`S2_ENHANCEMENT_REVIEW.md`](S2_ENHANCEMENT_REVIEW.md).

## Sources

- [sherpa-onnx license](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)
- [sherpa-onnx hotword constraints](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)
- [sherpa-onnx speech enhancement API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/speech_enhancement.html)
- `android/app/libs/sherpa-onnx.aar`
- `android/app/src/main/kotlin/com/voice2text/app/transcription/RealSherpaTranscriptionEngine.kt`
- `android/app/src/main/kotlin/com/voice2text/app/transcription/TranscriptionModelRegistry.kt`
- `assets/sherpa/asr/paraformer-zh.json`
- `assets/sherpa/onnx/speech-enhancement.onnx`
- `benchmark/asr_benchmark_manifest.json`
- `benchmark/asr_model_candidates.json`
- `benchmark/audio/online_transducer_candidate_manifest.json`
- `benchmark/evaluate_online_transducer_candidate.py`
- `benchmark/asr_benchmark_results_2026-07-05.md`
