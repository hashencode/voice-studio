# Apple M4 ASR Decision Revision — Memory Advisory Only

Decision date: 2026-07-27. This revision follows the user's explicit removal of
the 2 GiB memory hard gate. CER/WER and RTF remain hard gates. Peak,
incremental, and retained RSS remain mandatory advisory metrics.

This is benchmark evidence only. It does not change the product default model,
product worker, diarization, navigation, or UI.

## Revised decision

- Chinese: `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`. Held-out CER is 11.22%, versus 14.42% for the
  previous Paraformer winner.
- Pure English: `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`. Held-out WER is 25.14%, versus 32.86% for the
  previous SenseVoice winner.
- Single-model compromise: `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` because it wins both independent
  held-out lanes under the revised policy.
- This is not a universal sweep: Chinese operational CER is 15.51% versus
  Paraformer 14.93%, and English far-field/noise remains a major weakness.

## Revised selection policy

- CER <= 35%, WER <= 35%, median RTF <= 0.5.
- No memory hard gate.
- Absolute peak, incremental peak, and retained-after-unload RSS are still
  measured and reported. A real OOM, crash, timeout, or cleanup failure remains
  a reliability failure.
- CPU, 2 threads, concurrency 1, fixed 15-second segments.

## Five-minute stability

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
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | CER 6.03% | 1130.0/1164.9 | 68994.2/69034.8 | 75488.6/75589.4 | 0.2226/0.2227 | 3195.5/3930.6 | 2759.5/2722.6/1317.2 | 5 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | WER 8.80% | 1120.2/1234.0 | 73902.6/74117.5 | 80525.0/80646.9 | 0.2359/0.2366 | 3559.3/3880.9 | 2774.1/2737.8/1313.4 | 5 |

Qwen3 stability is CER 6.03% Chinese and WER 8.80% English. It uses about
2.7-2.8 GiB peak RSS in this stage.

## Multi-scenario development

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
| zh | `sherpa-onnx-funasr-nano-int8-2025-12-30` | CER 17.92% | 1519.8/1543.3 | 74919.3/80795.6 | 81966.8/87818.8 | 0.2030/0.2141 | 3001.1/3741.3 | 2198.6/2154.0/1402.7 | 25 |
| en | `sherpa-onnx-funasr-nano-int8-2025-12-30` | WER 48.79% | 1528.2/1546.8 | 82806.8/93982.7 | 89840.3/101023.1 | 0.2220/0.2497 | 3249.1/9722.9 | 2185.3/2148.6/1545.7 | 25 |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | CER 15.06% | 1120.0/1141.3 | 84517.6/90582.4 | 91042.7/97142.4 | 0.2224/0.2400 | 3314.9/4036.1 | 2856.9/2815.8/1571.0 | 25 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | WER 27.71% | 1125.0/1143.3 | 88260.2/91379.1 | 94835.8/97922.7 | 0.2373/0.2449 | 3500.6/4215.9 | 2803.7/2761.6/1470.6 | 25 |

Removing the memory gate re-admitted FunASR Nano. Its new development results
are Chinese CER 17.92% and English WER 48.79%; it was therefore not promoted to
held-out. Qwen3 development is Chinese CER 15.06% and English WER 27.71%.

Qwen3 English far-field/noise WER is 77.97% despite strong clean (12.06%),
accent-proxy (10.06%), and long-form (11.50%) results.

## Held-out

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | CER 16.36% | 647.6/659.2 | 15808.8/16049.2 | 17914.3/18165.9 | 0.0427/0.0429 | 640.8/656.9 | 723.1/690.5/708.5 | 25 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.42% | 493.6/502.4 | 15369.0/15687.9 | 17265.4/17584.3 | 0.0415/0.0417 | 623.1/637.0 | 591.0/556.8/576.2 | 25 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | WER 33.23% | 617.0/629.1 | 43031.5/43661.7 | 47332.7/47938.4 | 0.1154/0.1157 | 1728.8/1757.2 | 1416.8/1375.1/1161.7 | 25 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 32.86% | 321.2/332.7 | 21467.0/21728.9 | 23262.2/23523.8 | 0.0575/0.0576 | 862.5/869.1 | 730.6/696.7/717.0 | 25 |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | CER 11.22% | 1114.6/1125.4 | 84092.9/86595.4 | 90611.9/93127.6 | 0.2257/0.2339 | 3355.8/3955.0 | 2832.2/2787.7/1462.0 | 25 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | WER 25.14% | 1099.7/1121.6 | 89995.5/91293.6 | 96497.8/97866.2 | 0.2416/0.2436 | 3607.4/4232.2 | 2827.3/2787.9/1476.8 | 25 |

Qwen3 Chinese held-out CER 11.22% is a 3.20-point improvement over Paraformer
14.42%. Qwen3 English held-out WER 25.14% is a 7.72-point improvement over
SenseVoice 32.86%. English far-field/noise remains poor at 71.14% WER.

## Operational

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.93% | 495.3/495.3 | 155411.1/155411.1 | 157965.6/157965.6 | 0.0415/0.0415 | 622.4/633.6 | 904.5/869.0/768.3 | 1 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 31.76% | 313.7/313.7 | 215215.2/215215.2 | 217643.5/217643.5 | 0.0575/0.0575 | 862.4/864.5 | 947.7/911.0/808.0 | 1 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | CER 16.48% | 312.8/312.8 | 215408.6/215408.6 | 217846.7/217846.7 | 0.0575/0.0575 | 862.4/863.4 | 878.5/843.5/741.2 | 1 |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | CER 15.51% | 1105.2/1105.2 | 842637.4/842637.4 | 849807.3/849807.3 | 0.2250/0.2250 | 3366.8/3814.9 | 2877.3/2833.9/1416.5 | 1 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | WER 26.76% | 1103.1/1103.1 | 859814.5/859814.5 | 867025.6/867025.6 | 0.2298/0.2298 | 3501.5/4036.9 | 2965.7/2921.5/1505.8 | 1 |

Qwen3 completed one 62.42-minute Chinese run and one 62.36-minute English run.
Chinese CER is 15.51%, RTF 0.2250, and peak RSS about 2.81 GiB. English WER is
26.76%, RTF 0.2298, and peak RSS about 2.90 GiB. These are one-hour-class runs,
not two-hour tests.

## Reliability and runtime compatibility

The existing 13 bounded orchestration probes remain applicable. During Qwen3
development, sherpa-onnx 1.13.4 returned a generated newline as an unescaped
control character inside result JSON. The benchmark-only worker now repairs
only control characters inside JSON strings, preserves valid escapes and
content, and frees the native result in a `finally` block. Unit and real
development/held-out/operational runs validate the path.

## Streaming latency

For Qwen3 in the pinned sherpa-onnx Dart runtime, first-partial, final, and tail
latency are `not_applicable` / `unsupported`. The integration uses the offline
recognizer and does not emit streaming partials; zero values are not invented.
Streaming-capable candidates retain their measured fields in the frozen prior
decision.

## Official-profile comparison

The Qwen3 generation settings match the sherpa example on the controls exposed
by this runtime: 2 threads, `max-new-tokens=512`, temperature approximately
zero, and `top-p=0.8`. The common formal comparison deliberately keeps fixed
15-second segments. Sherpa's long-audio example instead uses Silero VAD
(`threshold=0.2`, minimum speech 0.2 seconds, maximum speech 20 seconds), so
these long-form numbers are not claimed to reproduce an official corpus score.
Official published WER/CER values also use different corpora and scoring
normalization; they are reference points, not acceptance targets for this
authorized fixture set.

## Dispositions

| Language | Candidate | Disposition | Reason |
|---|---|---|---|
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | REJECTED_QUALITY_GATE | development CER 37.24% exceeds 35% |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | HELD_OUT_RUNNER_UP | held-out CER 16.36%; slower and heavier than non-int8 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | RECOMMENDED | held-out CER 14.42%; best independent Chinese result |
| zh/en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | REJECTED | Chinese Pareto-dominated; English WER 44.13% fails gate |
| zh/en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | EN_RECOMMENDED_SINGLE_MODEL_COMPROMISE | English winner; Chinese development/operational competitive |
| en | `sherpa-onnx-streaming-zipformer-en-20m-2023-02-17` | REJECTED_QUALITY_GATE | five-minute WER 72.44% |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | REJECTED_QUALITY_GATE | development WER 40.23% |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | HELD_OUT_RUNNER_UP | held-out WER 33.23%; slower and heavier than SenseVoice |
| zh | `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | REJECTED_RUNTIME_MODEL_METADATA | frozen runtime lane rejected model metadata |
| en | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27` | REJECTED_RUNTIME_MODEL_FORMAT | ORT protobuf parse failure in frozen runtime lane |
| zh | `sherpa-onnx-funasr-nano-int8-2025-12-30` | REJECTED_DEVELOPMENT_DOMINATED | memory gate removed; development CER 17.92% is worse than Qwen3 15.06% and Paraformer 15.56% |
| en | `sherpa-onnx-funasr-nano-int8-2025-12-30` | REJECTED_QUALITY_GATE | memory gate removed; development WER 48.79% exceeds 35% |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | RECOMMENDED | held-out CER 11.22% versus previous winner 14.42% |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | RECOMMENDED | held-out WER 25.14% versus previous winner 32.86% |

## Limitations

- FLEURS is read speech with deterministic far-field/noise transformation, not
  a true meeting corpus.
- Qwen3 English far-field/noise is substantially worse than its other scenarios.
- Long runs use shared fixed 15-second segmentation, not sherpa's example
  Silero-VAD profile.
- Qwen3 is materially slower and heavier than Paraformer and SenseVoice.
- A true two-hour, non-repeated, authorized meeting-domain run remains absent.

The machine-readable companion is `m4_asr_no_memory_gate_decision.json`.
Published artifacts contain aggregate metrics and hashes only.
