# Apple M4 macOS ASR Model Decision Report

Decision date: 2026-07-27. This report is benchmark evidence only. It does not
change the product default model, product worker, diarization, navigation, or UI.

## Decision

- Chinese: `sherpa-onnx-paraformer-zh-2024-03-09`. Held-out CER is
  14.42%; it is more accurate,
  faster, and uses less memory than the int8 Paraformer finalist in this lane.
- Pure English: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`. Held-out WER is
  32.86%; it is more accurate,
  about twice as fast, and materially lighter than Parakeet.
- If the product can ship only one model: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`. It wins English and
  remains competitive in Chinese (development CER 16.97%, 62.42-minute
  operational CER 16.48%). It is a compromise, not the best Chinese model.

## Environment and fixed measurement contract

- Apple M4, arm64, macOS 15.7.5 (24G624).
- Runtime lane: `sherpa-onnx-dart-1.13.4-macos-arm64`; runtime SHA-256
  `102e8383640a6752dc9c51060836aba6f3da75bd644c3ddada1a0c15b8df0f02`.
- CPU provider, 2 threads, concurrency 1, 15-second segments.
- Short/scenario cells used 1 warm-up plus 5 measured runs; measured order was
  rotated with seed 20260726. Tables report medians and nearest-rank P95.
- `loadMilliseconds` is cold recognizer/model construction. `decodeMilliseconds`
  is warm model inference. `endToEndWallMilliseconds` spans first accepted input
  through final result. RTF is decode/audio duration. Peak RSS is absolute
  process-group peak; retained RSS is the post-unload worker self-report.
- Hard gates: CER/WER <= 35%, RTF <= 0.5, absolute peak RSS <= 2 GiB.

## Corpus, scenarios, and licensing

Quality evidence uses local-only Google FLEURS audio under CC-BY 4.0. Chinese
uses CER and pure English uses WER. Development and held-out packs are disjoint
validation/test splits and are hash-bound below. Each contains clean,
far-field/noise transformation, speaker-variability accent proxy,
terminology/numbers, and long-form scenarios. Raw audio, reference text,
transcripts, model files, credentials, cookies, absolute paths, and restricted
assets are not published.

FLEURS is read speech, not a true meeting corpus. “Accent” means natural speaker
variability rather than reviewed accent labels, and far-field is a deterministic
echo/noise transform. There is no mandatory code-switch test. These limitations
constrain external validity and must be revisited before a meeting-domain product
switch.

## Evidence separation

Stage 0 was a real M4 runtime smoke only: 10 candidate/language attempts, 8
admitted and 2 runtime-admission failures. It proves execution and sampling, not
ranking. The formal evidence below is kept separate.

### Five-minute stability

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | CER 25.42% | 112.1/113.3 | 2685.9/2731.8 | 3256.5/3304.3 | 0.0087/0.0088 | 136.0/140.9 | 199.9/164.9/187.2 | 5 |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | CER 8.61% | 657.4/709.1 | 13357.5/13413.6 | 15470.2/15576.0 | 0.0431/0.0433 | 644.3/665.6 | 655.8/619.1/585.0 | 5 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 9.69% | 515.6/517.9 | 13022.7/13232.2 | 14942.7/15160.7 | 0.0420/0.0427 | 627.6/769.2 | 738.0/697.9/599.0 | 5 |
| zh | `sherpa-onnx-funasr-nano-int8-2025-12-30` | CER 15.43% | 1521.5/1534.6 | 61293.6/61357.8 | 68303.7/68403.8 | 0.1977/0.1979 | 2913.8/3488.6 | 2124.3/2083.5/1394.0 | 5 |
| zh | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | CER 11.37% | 459.1/475.6 | 103840.1/105760.0 | 108561.0/110458.9 | 0.3350/0.3412 | 5033.2/5243.5 | 1431.8/1394.0/1164.9 | 5 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | CER 9.89% | 339.8/406.9 | 18026.7/18029.5 | 19836.9/19874.4 | 0.0582/0.0582 | 869.8/874.3 | 741.5/701.8/726.8 | 5 |
| en | `sherpa-onnx-streaming-zipformer-en-20m-2023-02-17` | WER 72.44% | 96.9/98.4 | 3504.2/3535.4 | 4150.3/4186.5 | 0.0112/0.0113 | 172.7/178.6 | 192.9/158.9/181.0 | 5 |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | WER 28.86% | 207.3/209.2 | 15219.8/15250.7 | 16473.4/16513.2 | 0.0486/0.0487 | 683.6/1333.7 | 729.6/699.4/612.8 | 5 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | WER 24.96% | 615.2/624.5 | 36241.6/36261.4 | 40539.6/40551.0 | 0.1157/0.1157 | 1733.1/1749.0 | 1389.4/1349.4/1027.1 | 5 |
| en | `sherpa-onnx-funasr-nano-int8-2025-12-30` | WER 21.65% | 1488.4/1536.8 | 66828.8/66884.7 | 73806.4/73926.0 | 0.2133/0.2135 | 3121.9/3884.3 | 2061.7/2022.8/1110.5 | 5 |
| en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | WER 33.48% | 443.0/449.2 | 105778.3/105885.8 | 110492.3/110609.9 | 0.3376/0.3379 | 5026.6/5314.2 | 1366.7/1322.7/972.1 | 5 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 14.57% | 323.2/324.8 | 18037.1/18055.5 | 19824.6/19832.7 | 0.0576/0.0576 | 863.2/867.5 | 642.1/608.5/627.4 | 5 |

The stability fixture is approximately five minutes per language. FunASR Nano
exceeded the 2 GiB absolute peak gate in both lanes. The English Zipformer
baseline failed the WER gate. Runtime-rejected Streaming Zipformer 2025 and
Moonshine have no fabricated metrics.

### Multi-scenario development

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | CER 37.24% | 108.3/109.3 | 3210.7/3292.1 | 3815.9/3892.6 | 0.0085/0.0087 | 132.9/147.1 | 203.7/171.9/191.7 | 25 |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | CER 16.75% | 645.3/658.7 | 16224.2/16288.3 | 18334.3/18386.1 | 0.0427/0.0430 | 638.3/659.0 | 647.6/609.2/603.2 | 25 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 15.56% | 492.0/516.2 | 15747.2/15835.6 | 17655.8/17731.6 | 0.0415/0.0417 | 621.7/636.3 | 655.2/623.1/641.6 | 25 |
| zh | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | CER 17.62% | 438.0/455.9 | 126062.6/129492.2 | 130741.2/134199.8 | 0.3350/0.3432 | 5006.7/5330.9 | 1396.5/1362.1/1002.0 | 25 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | CER 16.97% | 315.3/323.5 | 21711.7/21953.6 | 23494.9/23745.2 | 0.0575/0.0576 | 862.5/868.6 | 655.5/621.8/640.8 | 25 |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | WER 40.23% | 205.2/207.1 | 17207.7/17620.9 | 18470.6/18884.4 | 0.0463/0.0472 | 675.6/932.0 | 749.5/718.6/632.7 | 25 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | WER 34.69% | 616.7/639.9 | 42967.8/43426.8 | 47250.3/47691.2 | 0.1152/0.1155 | 1727.2/1749.4 | 1397.6/1362.2/1050.3 | 25 |
| en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | WER 44.13% | 440.4/463.2 | 125236.3/128222.6 | 129981.4/132929.7 | 0.3347/0.3406 | 5007.9/5328.9 | 1478.3/1443.9/956.9 | 25 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 33.41% | 318.2/336.7 | 21467.5/21680.3 | 23239.2/23475.9 | 0.0575/0.0576 | 862.5/869.0 | 758.6/723.0/645.8 | 25 |

Development contains five approximately six-minute scenarios per language
(about 31 minutes/lane). The frozen finalists were Chinese Paraformer int8 and
non-int8, and English Parakeet and SenseVoice. FireRed was dominated in Chinese
and failed English quality; Whisper failed English quality. SenseVoice was kept
as the cross-language compromise, but was not retroactively added to the frozen
Chinese held-out ranking.

### Held-out validation

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | CER 16.36% | 647.6/659.2 | 15808.8/16049.2 | 17914.3/18165.9 | 0.0427/0.0429 | 640.8/656.9 | 723.1/690.5/708.5 | 25 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.42% | 493.6/502.4 | 15369.0/15687.9 | 17265.4/17584.3 | 0.0415/0.0417 | 623.1/637.0 | 591.0/556.8/576.2 | 25 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | WER 33.23% | 617.0/629.1 | 43031.5/43661.7 | 47332.7/47938.4 | 0.1154/0.1157 | 1728.8/1757.2 | 1416.8/1375.1/1161.7 | 25 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 32.86% | 321.2/332.7 | 21467.0/21728.9 | 23262.2/23523.8 | 0.0575/0.0576 | 862.5/869.1 | 730.6/696.7/717.0 | 25 |

Held-out uses disjoint test-split packs of about 31 minutes/lane. Chinese
non-int8 Paraformer wins on CER, latency, and memory. English SenseVoice wins on
WER, latency, and memory. Both pass every hard gate.

### Streaming observations

- Chinese streaming-capable Zipformer baseline: 5 measured real-time-paced
  runs; first partial median/P95
  4489.5/
  4492.1 ms, final
  11062.8/
  11063.1 ms, tail
  2.8/
  3.1 ms.
- SenseVoice is offline-only in this runtime lane. First partial, streaming final,
  and tail latency are explicitly `not_applicable/unsupported`, never zero.
- The 2025 Streaming Zipformer was rejected before measurement because its model
  metadata is incompatible with this frozen runtime lane. No cross-runtime result
  is ranked.

### Operational evidence

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.93% | 495.3/495.3 | 155411.1/155411.1 | 157965.6/157965.6 | 0.0415/0.0415 | 622.4/633.6 | 904.5/869.0/768.3 | 1 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 31.76% | 313.7/313.7 | 215215.2/215215.2 | 217643.5/217643.5 | 0.0575/0.0575 | 862.4/864.5 | 947.7/911.0/808.0 | 1 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | CER 16.48% | 312.8/312.8 | 215408.6/215408.6 | 217846.7/217846.7 | 0.0575/0.0575 | 862.4/863.4 | 878.5/843.5/741.2 | 1 |

Only two unique final candidates were run. Each operational fixture concatenates
ten distinct development/held-out scenario blocks with one-second separators:
Chinese 62.42 minutes and English 62.36 minutes. These are single measured runs,
so their P95 equals the one observation. They are honest one-hour-class runs,
not 2-hour tests; a 2-hour run remains unavailable because the licensed,
non-repeated lane corpus is only about 62 minutes. No shorter smoke is presented
as a long test.

## Reliability and determinism

All 13 bounded orchestration
probes passed: crash, timeout, oom, empty_output, malformed_output, malformed_input, short_input, silent_input, deterministic_repeat, term_resistant_cancellation, temporary_cleanup, sandbox_denial, atomic_publication. They cover crash, timeout, OOM, empty/malformed output,
malformed/very-short/silent input, deterministic repetition, TERM-resistant
cancellation with process-group and descendant cleanup, temporary cleanup,
network and user-home denial, and atomic publication.

Every real run was launched in the network-denied sidecar sandbox. Transcript-only
determinism was stable across
385 measured
runs and
77
candidate/fixture groups. Raw-output hashes are intentionally not used for this
claim because model timestamps can vary. Peak and retained RSS are reported for
each measured aggregate; retained RSS is not treated as zero after unload.

## Hard-gate dispositions and elimination reasons

| Language | Candidate | Disposition | Reason |
|---|---|---|---|
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | REJECTED_QUALITY_GATE | development CER 37.24% exceeds 35% |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | HELD_OUT_RUNNER_UP | held-out CER 16.36%; slower and heavier than non-int8 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | RECOMMENDED | held-out CER 14.42%; best independent Chinese result |
| zh/en | `sherpa-onnx-funasr-nano-int8-2025-12-30` | REJECTED_RESOURCE_GATE | five-minute absolute peak RSS exceeded 2 GiB |
| zh/en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | REJECTED | Chinese Pareto-dominated; English WER 44.13% fails gate |
| zh/en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | EN_RECOMMENDED_SINGLE_MODEL_COMPROMISE | English winner; Chinese development/operational competitive |
| en | `sherpa-onnx-streaming-zipformer-en-20m-2023-02-17` | REJECTED_QUALITY_GATE | five-minute WER 72.44% |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | REJECTED_QUALITY_GATE | development WER 40.23% |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | HELD_OUT_RUNNER_UP | held-out WER 33.23%; slower and heavier than SenseVoice |
| zh | `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | REJECTED_RUNTIME_MODEL_METADATA | frozen runtime lane rejected model metadata |
| en | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27` | REJECTED_RUNTIME_MODEL_FORMAT | ORT protobuf parse failure in frozen runtime lane |

## Bindings and privacy

- Contract SHA-256: `5fba77673c05d15209207d959ce7564266c2d7c777db6876f22698e97797ee72`
- Candidate registry SHA-256: `ac229c7439085cd1974a704cc1dcd3bb1b5d061588b021f55a67628acbc5dfc4`
- Development Chinese manifest SHA-256:
  `53be068c98bc5c3e92d19ddecb70ea6afeb4aef892e106acb90c8a3a440fd803`
- Development English manifest SHA-256:
  `58e5a15296f5785d7e2d502a41abd1502c9fab6dd2c816e5d3fef57f28746acf`
- Held-out Chinese manifest SHA-256:
  `453f0d5e3b8ffa32a30f41bc14a6dde3c5c83dbf8cd5257eed732f23f9799bd9`
- Held-out English manifest SHA-256:
  `e0bb47c330b6e2b659e0d04699d29a169324753ae13edba96eb1191acfd04592`

The machine-readable companion is `m4_asr_model_decision.json`. Published
artifacts contain aggregate numeric evidence and hashes only.

## Remaining validation before any product switch

Run a true two-hour, non-repeated, authorized meeting-domain corpus per finalist;
add reviewed accent strata and real far-field rooms; observe thermal behavior;
and rerun an equivalent Zipformer baseline if a new runtime lane is introduced.
Any product switch requires separate explicit approval and product-level testing.
