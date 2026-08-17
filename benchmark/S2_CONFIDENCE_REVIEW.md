# S2 Confidence Signal Review

Date: 2026-07-25

## Scope disposition

Decision `S2-MOBILE-CORE-2026-07-25` keeps manual review states in S2 Mobile
Core and marks automatic confidence as `DEFERRED_TO_PC` /
`DEFERRED_NOT_PASSED`. Production Paraformer continues to return unknown/null;
the raw-score evidence below is not a calibrated correctness probability.

## Result

ASR-006 automatic low-confidence review remains closed with reason `recognizer_confidence_unavailable`.

Manual `unreviewed`, `needs_review`, and `reviewed` states remain available. They are user decisions and are intentionally independent from the nullable model confidence field.

## Production evidence

- The installed sherpa-onnx Android AAR is v1.13.3 with SHA-256 `243ad797a3b6e75ebbeaf7a2ab4aec0777e7d71b730685abb762a120940b07b6`.
- Its `OfflineRecognizerResult` exposes text, tokens, timestamps, language, emotion, event, and durations, but no confidence, score, log probability, or token probability.
- `RealSherpaTranscriptionEngine` therefore writes `confidence = null` for every production VAD segment.
- The 2026-07-24 Xiaomi M2102J2SC production smoke produced 19 segments and asserted that every confidence value remained `null`.

The Android and Dart result contracts preserve nullable confidence; SQLite stores it as nullable `REAL`; the meeting timeline renders `null` as `置信度未知`. Manual review transitions preserve the original value and never manufacture or overwrite a score.

## Candidate path assessment

A model-only swap is insufficient with the installed runtime API: all offline model families are returned through the same `OfflineRecognizerResult`, which exposes no score. The minimum viable candidate therefore requires both:

1. a runtime/API that exposes a documented per-token or per-segment probability or log-probability tied to decoded output; and
2. a compatible offline Chinese model whose accuracy, timestamps, RTF, memory, package size, and physical-device compatibility meet the existing Paraformer baseline.

Candidate evaluation must use an independently labeled calibration split and a held-out validation split. The report must include coverage, reliability/calibration error, precision and recall for the proposed low-confidence threshold, and false-positive impact on ordinary speech. A threshold must be selected before the held-out run and must not convert an automatic candidate into the human `reviewed` state.

Until a candidate passes those gates, the production model, nullable transport, database schema, manual review flow, and UI remain unchanged.

## 2026-07-25 online candidate screening

The pinned 14M Chinese streaming Zipformer candidate was evaluated only in an
Android instrumentation route on the Xiaomi mid-class reference. It returned
one timestamp and one raw `ysProbs` value for every emitted token. This closes
the API-discovery question but not the confidence gate:

- baseline had 964 tokens/scores; hotword mode had 966;
- raw scores ranged from -2.598 to -0.060;
- the fixed reference comparison found 50 baseline and 48 hotword edit
  operations, all deletions. No emitted token was labeled incorrect;
- consequently ROC AUC, threshold precision/recall, and false-positive impact
  cannot be estimated from this corpus;
- there is no independently labeled calibration split or held-out validation
  split.

`exp(ysProbs)` was reported only as an exploratory transformation, never as a
production probability. ASR-006 remains BLOCKED and the production Paraformer
continues to emit `confidence=null`.

Reproduce the screening evaluation:

```bash
python3 benchmark/prepare_asr_candidate.py \
  streaming-zipformer-zh-14m-2023-02-23
python3 benchmark/evaluate_online_transducer_candidate.py \
  --evidence build/asr_benchmark/online-transducer-candidate-xiaomi.json \
  --report build/asr_benchmark/online-transducer-candidate-evaluation-xiaomi.json
```

## Reproduce current contract

```bash
cd apps/mobile-flutter && flutter test \
  test/features/transcription/transcription_result_contract_test.dart \
  test/features/transcription/transcript_segments_repository_test.dart \
  test/features/meetings/meeting_review_controller_test.dart \
  test/features/meetings/transcript_timeline_test.dart

cd apps/mobile-flutter/android
./gradlew :app:testDebugUnitTest \
  --tests 'com.voice2text.app.transcription.TranscriptionResultTest' \
  --tests 'com.voice2text.app.transcription.VadTimestampMapperTest'
```
