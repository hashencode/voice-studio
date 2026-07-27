# Apple M4 ASR Official-Metric and Parameter-Parity Supplement

This supplement answers whether the local CER/WER can be compared directly with
official model-card numbers and whether recommended parameters change recognition
on the same audio. It does not change the frozen M4 model decision or any product
default.

This document preserves the initial short parameter-parity result. Qwen3 later
completed stability, development, held-out, and one-hour-class operational
stages; the current selection is in `M4_ASR_NO_MEMORY_GATE_DECISION_REPORT.md`.

## Answer

- No official number is directly comparable to the local result. Dataset, domain,
  normalization, segmentation, quantization, and runtime differ.
- Recommended versus fixed-resource profiles produced identical CER/WER and
  identical output hashes for all 11 tested
  candidate/language pairs. The observed quality gap to model cards is therefore
  not explained by these decoder/profile settings on the controlled short audio.
- Qwen3-ASR 0.6B int8 was admitted in the existing sherpa-onnx 1.13.4 lane. It
  achieved 0% CER and 0% WER on one short clean utterance per language, but this
  row remains parameter-parity evidence only, not a development or held-out
  ranking.
- Qwen3 peak RSS was near the 2 GiB gate and crossed it in one fixed-resource
  lane aggregate. Memory is advisory in the later decision revision; official
  VAD-based long-audio parity remains a limitation.

## Existing formal model data

These tables reproduce the already frozen evidence. They remain the source for
ranking; the short parity experiment below is deliberately not rank-eligible.

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

### Held-out

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | CER 16.36% | 647.6/659.2 | 15808.8/16049.2 | 17914.3/18165.9 | 0.0427/0.0429 | 640.8/656.9 | 723.1/690.5/708.5 | 25 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.42% | 493.6/502.4 | 15369.0/15687.9 | 17265.4/17584.3 | 0.0415/0.0417 | 623.1/637.0 | 591.0/556.8/576.2 | 25 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | WER 33.23% | 617.0/629.1 | 43031.5/43661.7 | 47332.7/47938.4 | 0.1154/0.1157 | 1728.8/1757.2 | 1416.8/1375.1/1161.7 | 25 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 32.86% | 321.2/332.7 | 21467.0/21728.9 | 23262.2/23523.8 | 0.0575/0.0576 | 862.5/869.1 | 730.6/696.7/717.0 | 25 |

### Operational

| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | CER 14.93% | 495.3/495.3 | 155411.1/155411.1 | 157965.6/157965.6 | 0.0415/0.0415 | 622.4/633.6 | 904.5/869.0/768.3 | 1 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | WER 31.76% | 313.7/313.7 | 215215.2/215215.2 | 217643.5/217643.5 | 0.0575/0.0575 | 862.4/864.5 | 947.7/911.0/808.0 | 1 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | CER 16.48% | 312.8/312.8 | 215408.6/215408.6 | 217846.7/217846.7 | 0.0575/0.0575 | 862.4/863.4 | 878.5/843.5/741.2 | 1 |

## Same-audio parameter parity

Each cell used one authorized FLEURS utterance that fits within one 15-second
segment, one warm-up, and five measured runs. `official_or_model_recommended`
means the candidate's existing recommended profile; Qwen3 uses the explicit
sherpa defaults: CPU, 2 threads, max total/new tokens 512/512, temperature
0.000001, top-p 0.8, seed 42, and no hotwords.

| Language | Candidate | Profile | CER/WER | Load ms | Decode ms | E2E ms | RTF | Segment P50/P95 ms | Peak/retained MiB | Output variants |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | official_or_model_recommended | CER 10.34% | 110.5 | 218.6 | 11454.2 | 0.0198 | 11061.4/11061.4 | 131.9/103.6 | 1 |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | official_or_model_recommended | CER 0.00% | 673.9 | 470.6 | 2537.1 | 0.0426 | 470.5/470.5 | 685.3/597.0 | 1 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | official_or_model_recommended | CER 0.00% | 514.1 | 457.9 | 2301.9 | 0.0414 | 457.8/457.8 | 668.9/511.3 | 1 |
| zh | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | official_or_model_recommended | CER 0.00% | 479.4 | 3601.4 | 8257.3 | 0.3256 | 3601.3/3601.3 | 1490.7/1061.1 | 1 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | official_or_model_recommended | CER 0.00% | 342.4 | 641.8 | 2382.6 | 0.0580 | 641.7/641.7 | 702.5/581.5 | 1 |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | official_recommended | CER 0.00% | 1111.5 | 2401.0 | 8810.3 | 0.2171 | 2400.9/2400.9 | 2003.4/855.4 | 1 |
| zh | `sherpa-streaming-zipformer-zh-14m-2023-02-23` | fixed_resource | CER 10.34% | 110.2 | 96.3 | 485.2 | 0.0087 | 100.6/100.6 | 128.2/102.7 | 1 |
| zh | `sherpa-onnx-paraformer-zh-int8-2025-10-07` | fixed_resource | CER 0.00% | 680.5 | 470.7 | 2551.4 | 0.0426 | 470.6/470.6 | 691.0/597.7 | 1 |
| zh | `sherpa-onnx-paraformer-zh-2024-03-09` | fixed_resource | CER 0.00% | 516.0 | 458.3 | 2313.0 | 0.0414 | 458.2/458.2 | 592.4/530.5 | 1 |
| zh | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | fixed_resource | CER 0.00% | 474.4 | 3640.0 | 8314.4 | 0.3291 | 3639.9/3639.9 | 1388.9/894.7 | 1 |
| zh | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | fixed_resource | CER 0.00% | 345.8 | 642.5 | 2383.4 | 0.0581 | 642.4/642.4 | 737.9/586.6 | 1 |
| zh | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | fixed_resource | CER 0.00% | 1123.0 | 2414.8 | 8849.3 | 0.2183 | 2414.6/2414.6 | 2079.2/1060.7 | 1 |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | official_or_model_recommended | WER 0.00% | 213.1 | 445.1 | 1642.9 | 0.0460 | 445.0/445.0 | 526.2/501.8 | 1 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | official_or_model_recommended | WER 0.00% | 645.6 | 1143.5 | 5421.3 | 0.1181 | 1143.5/1143.5 | 1288.9/833.8 | 1 |
| en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | official_or_model_recommended | WER 12.50% | 475.0 | 3198.3 | 7873.0 | 0.3304 | 3198.2/3198.2 | 1385.3/1060.9 | 1 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | official_or_model_recommended | WER 0.00% | 334.7 | 556.0 | 2307.5 | 0.0574 | 555.9/555.9 | 746.8/586.0 | 1 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | official_recommended | WER 0.00% | 1132.3 | 2258.4 | 8716.6 | 0.2333 | 2258.3/2258.3 | 1994.3/1138.9 | 1 |
| en | `sherpa-onnx-whisper-base-en-int8-2023-01-31` | fixed_resource | WER 0.00% | 212.1 | 445.2 | 1647.4 | 0.0460 | 445.1/445.1 | 534.6/494.4 | 1 |
| en | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01` | fixed_resource | WER 0.00% | 651.4 | 1143.8 | 5410.0 | 0.1182 | 1143.7/1143.7 | 1232.1/929.1 | 1 |
| en | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` | fixed_resource | WER 12.50% | 491.7 | 3217.8 | 7912.0 | 0.3324 | 3217.7/3217.7 | 1433.2/962.1 | 1 |
| en | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | fixed_resource | WER 0.00% | 336.1 | 554.2 | 2296.7 | 0.0573 | 554.1/554.1 | 696.2/556.8 | 1 |
| en | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` | fixed_resource | WER 0.00% | 1150.0 | 2262.5 | 8733.4 | 0.2337 | 2262.4/2262.4 | 1920.7/1062.8 | 1 |

For the real-time-paced Chinese Zipformer profile, end-to-end time includes audio
pacing; fixed-resource mode is unpaced. Its transcript and CER are still
identical, so the large wall-time difference is expected execution policy, not a
quality improvement.

## Official-document comparison

- Qwen's model card reports a 6.31% mean WER on the Open ASR Leaderboard. This is
  an aggregate over other datasets using the upstream model, not the local
  sherpa-onnx int8 conversion on FLEURS.
- Whisper base.en documents 4.271% WER on LibriSpeech test-clean. The local
  development result is 40.23% on a five-scenario FLEURS pack with an int8
  sherpa-onnx runtime and fixed segmentation. These are different experiments.
- Parakeet's card reports a suite of Open ASR datasets with native NeMo/GPU
  greedy Transducer decoding. There is no one official number corresponding to
  this CPU/int8/FLEURS lane.
- For several sherpa conversion pages, the documentation provides runnable audio
  examples rather than a matched corpus-level CER/WER. A transcript example is
  not an official comparable benchmark.

## Qwen3 official long-audio parameters

The sherpa documentation uses Silero VAD for long files: threshold 0.2, minimum
speech duration 0.2 seconds, maximum speech duration 20 seconds, CPU 2 threads,
and max-new-tokens 512. The current fixed benchmark uses deterministic 15-second
segments so every model receives identical resources. A proper Qwen long-audio
follow-up must add a separately named VAD profile; feeding a five-minute file as
one utterance would not reproduce the official recommendation.

## Interpretation

The short A/B isolates parameter effects but cannot prove broad quality. The
formal development/held-out differences are primarily attributable to corpus and
runtime differences, with segmentation and normalization as additional factors.
The subsequent Qwen3 admission preserved the frozen candidate set as historical
evidence, created a new comparison revision, and ran the full stability,
development, held-out, reliability, and operational sequence.

The machine-readable companion is
`m4_asr_official_parameter_parity.json`. It contains aggregates and hashes only;
no audio, references, transcripts, model files, credentials, or absolute paths
are published.
