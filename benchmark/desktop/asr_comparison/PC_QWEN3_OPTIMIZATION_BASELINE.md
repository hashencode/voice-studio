# PC Qwen3-ASR Optimization Baseline

Baseline date: 2026-07-28
Baseline ID: `pc-qwen3-asr-product-baseline-v1`

## Product decision

The desktop product has one ASR model profile:
`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`, CPU provider, two threads,
concurrency one, official Silero VAD segmentation, `maxTotalLen=512`,
`maxNewTokens=512`, `temperature=1e-6`, `topP=0.8`, `seed=42`, and empty
hotwords. U17 froze the VAD at `threshold=0.2`, `minSpeech=0.2`, and
`maxSpeech=12` seconds. Speaker
diarization remains an independent product capability and is not an alternative
ASR model.

The product stays on the currently integrated sherpa-onnx 1.13.4 / ORT 1.27
runtime lane. The native ORT 1.24.4 arm passed its isolated speed and quality
gates, but the fixed evaluator selected the admitted arm with the lowest error
rate. Combining the faster runtime with the VAD winner would violate the
single-variable contract, so it is not a product runtime pin.

## Frozen measurements

| Measurement | Baseline |
|---|---:|
| Chinese held-out CER | 11.22% |
| English held-out WER | 25.14% |
| Chinese fixed-15 median RTF | 0.2257 |
| English fixed-15 median RTF | 0.2416 |
| Current Dart worker on official Obama audio | 0.2514 median / 0.2520 P95 |
| Best native diagnostic on official Obama audio | 0.1242 median / 0.1243 P95 |
| Same-source ORT 1.27 / ORT 1.24.4 ratio | 2.061x |
| Fixed-15 / official Silero controlled difference | approximately 1.003x |
| Qwen3 result conversion share | 0.000701% |
| U17 control / selected aggregate error | 0.225381 / 0.200605 |
| U17 control / selected non-target error | 0.267542 / 0.240118 |
| U17 selected RTF / P95 segment latency | 0.206783 / 5130.81 ms |

Future optimization claims must name the audio set, model hashes, runtime lane,
provider, thread count, segmentation, timing boundary, warm-up count, measured
count, and memory sampler. Results from diagnostic lanes must not silently
replace the frozen product baseline or historical candidate ranking.

## Evidence boundary

The complete aggregate reports and machine-readable evidence are:

- `M4_ASR_NO_MEMORY_GATE_DECISION_REPORT.md`
- `m4_asr_no_memory_gate_decision.json`
- `M4_QWEN3_OFFICIAL_RTF_REPRODUCTION_REPORT.md`
- `m4_qwen3_official_rtf_reproduction.json`
- `qwen3_experiment_m4.json`
- `qwen3_m4_development_freeze.json`
- `evidence/qwen3-optimization/macos/matrix.json`
- `evidence/qwen3-optimization/macos/u17-raw-manifest.json`
- `evidence/qwen3-optimization/macos/u17-summary.json`
- `evidence/qwen3-optimization/macos/u17-decision.json`
- `evidence/qwen3-optimization/macos/u17-product-worker-smoke.json`

Their SHA-256 bindings are recorded in
`pc_qwen3_optimization_baseline.json`. Local audio, models, raw transcripts,
runtime binaries, credentials, and absolute paths remain excluded.

## Release caveat

The upstream Qwen3-ASR model and official repository are Apache-2.0. The
tested sherpa archive points to a third-party ONNX conversion repository that
does not currently publish a standalone repository license. The product
manifest therefore keeps a visible converter-license review requirement.
Release builds block activation of this development-only asset. Before external
distribution, obtain explicit converter provenance or produce
and re-benchmark a first-party conversion from the Apache-2.0 upstream model.
