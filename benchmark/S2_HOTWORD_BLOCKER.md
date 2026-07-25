# S2 Hotword Gate

Date: 2026-07-25

## Scope disposition

Decision `S2-MOBILE-CORE-2026-07-25` marks hotwords as `DEFERRED_TO_PC` /
`DEFERRED_NOT_PASSED`; mobile Paraformer remains unchanged and exposes no
product entry. The future PC path must use a Transducer with
`modified_beam_search` and must improve preregistered target-word hits without
unacceptable non-target or resource regressions.

## Result

ASR-007 meeting-level and device-level hotwords remain closed with reason `paraformer_hotwords_unsupported`. Organization-level terminology remains outside the current identity boundary.

## Installed-path evidence

- Production model: offline Paraformer `sherpa-onnx-paraformer-zh-int8-2025-10-07`.
- Production decoder: greedy offline Paraformer.
- Installed AAR: sherpa-onnx v1.13.3.
- The generic `OfflineRecognizerConfig` has `hotwordsFile` and `hotwordsScore`, but that configuration surface is not evidence that every model family accepts contextual biasing.
- Sherpa's official hotword documentation restricts hotwords to transducer models with `modified_beam_search`.
- The production Dart request, MethodChannel payload, Android request, engine, settings, and meeting UI expose no hotword or terminology parameter.

Therefore the app cannot accept a terminology list as a successful production capability. Post-recognition string replacement would change text after decoding and is explicitly not a hotword implementation.

## 2026-07-25 decoder-stage A/B result

The pinned, Apache-2.0 14M Chinese streaming Zipformer candidate ran on the
Xiaomi M2102J2SC with the same model, corpus, `modified_beam_search`, and four
active paths in both arms. The only A/B change was the preregistered hotword
file at score 1.5.

| Metric | No hotwords | Hotwords |
| --- | ---: | ---: |
| CER | 4.931% | 4.734% |
| RTF | 0.0780 | 0.0994 |
| Emitted tokens | 964 | 966 |
| `英特尔` + `相思风雨中` hits | 52 | 52 |

The changed text and two-character CER improvement prove a real decoder-stage
effect. They do not satisfy ASR-007: the preregistered target phrases were
already recognized at ceiling and their hit rate did not improve. The test
must not be redefined after seeing the baseline. The candidate also lacks
low-device, independent calibration, complete timestamp, and production
integration gates, so it remains isolated and `lab_only`.

Raw report SHA-256:
`7b6c9f0f723d90d37b5de0bf01a9c03e9e3332694f80c54e0fc272a912c7b0c9`.
Evaluation SHA-256:
`8170f11f4d6708b9c5ec50579326eee80e05d07b90866bda938b29076c5d216e`.

## Candidate evaluation required

A future candidate must pair the same fixed professional-word audio set with hotwords disabled and enabled at the decoder. It must demonstrate improved target-term hit rate while staying within preregistered ordinary-word regression, CER/WER, timestamp, RTF, memory, package-size, and physical-device limits.

Only after that paired result may the app add:

- device and meeting terminology persistence;
- scope-aware request fields and decoder configuration;
- settings and meeting UI;
- a committed `benchmark/hotword_manifest.json`;
- the shared S2 SQLite v18 terminology tables.

Because the current gate failed, U4 does not reserve or modify schema v18. U7 remains the sole owner of the S2 closure migration and will add only retention settings unless a later verified hotword candidate reopens this decision.

## Reproduce current contract

```bash
flutter test \
  test/features/transcription/transcription_runtime_contract_test.dart \
  test/features/settings/transcription_model_descriptor_test.dart

cd android
./gradlew :app:testDebugUnitTest \
  --tests 'com.voice2text.app.transcription.TranscriptionEngineRouterTest'
```

Primary reference: [sherpa-onnx hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html).
