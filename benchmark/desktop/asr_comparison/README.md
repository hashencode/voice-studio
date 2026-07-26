# macOS ASR comparison v2

This directory is a benchmark-only comparison boundary. It does not replace or
reinterpret the frozen desktop product v1 contract, selected Zipformer model,
production worker, diarization pipeline, or UI.

The first round contains exactly seven identities:

- the current Zipformer 14M baseline;
- the 2025-10-07 mobile-parity Paraformer;
- the pinned 2024-03-09 general Mandarin Paraformer;
- the 2025-06-30 streaming Zipformer;
- FunASR Nano;
- FireRedASR2 CTC; and
- native FunASR 1.3.22 as a short-stage cross-runtime control.

Unqualified names such as `FunASR` and `Paraformer` are not candidate
identities. Native FunASR is never inserted into a sherpa-onnx ranking lane.
Every rankable sherpa runtime lane must contain a freshly executed Zipformer 14M
baseline for that exact runtime build and macOS target.

## Contract validation

Run the fail-closed bundle validator:

```bash
python3 benchmark/desktop/asr_comparison/validate_contract.py --print-hashes
```

The three bundle files are SHA-256-bound at run start. Unknown rank-affecting
keys are rejected. `diagnosticExtensions` is the only bounded extension
namespace and cannot change ranking behavior.

Candidates with unavailable external artifacts remain explicitly pending.
`ADMITTED` is valid only when every artifact and runtime is hash-pinned, license
review is accepted, the installed API is supported, processing is proven
offline, and a macOS smoke decode passes. Android evidence remains
screening-only.

## Profiles and stages

Sherpa candidates have family-specific `recommended` profiles and a shared
two-thread, concurrency-one `fixed-resource` core-ASR profile. Unsupported
controls are recorded under `notApplicableControls`; they are not silently
emulated. Core-ASR and end-to-end scorecards remain separate.

The runner implements the staged funnel:

1. Stage 0: identity, hash, license, API, offline, and smoke admission.
2. Stage 1: short recommended and fixed-resource screening.
3. Stage 2: frozen held-out quality ranking.
4. Stage 3: product-finalist and 7,200-second operational gates.

This Goal implements and smoke-validates the U1-U6 tooling only. It does not run
the U7 development pilot, freeze a ranked development round, inspect held-out
output, rank candidates, or execute the two-hour finalist gate.

## Provisioning, processing, and local data

Provisioning is a separate explicit phase that may use the network. Candidate
processing must run in the macOS sandbox with network and user-home access
denied. Model archives, restricted corpora, decoded audio, transcripts, raw
runs, and staging data live under `build/desktop_asr_comparison/` and are never
committed.

Committed or deterministically generated smoke fixtures keep the implementation
vertically runnable when licensed local corpora or candidate models are absent.
Ranked execution must fail with an actionable missing-prerequisite disposition
until all local-only assets, independent reference review, artifact hashes, and
license dispositions are complete.

Prepare the smoke fixture pack with:

```bash
python3 benchmark/desktop/asr_comparison/prepare_fixtures.py
```

The local-only acquisition and review checklist is in
`benchmark/desktop/asr_comparison/fixtures/README.md`.

Publishable evidence is bounded JSON. It contains hashes and aggregate metrics,
not audio, PCM, transcripts, embeddings, voiceprints, secrets, private labels,
user-home paths, or absolute paths.

## Shared scoring and aggregation

`asr_scoring.py` is the only comparison-v2 lexical/display scorer. It keeps
recognition edits separate from punctuation and ITN rendering, and exposes
terminology, numeric, code-switch, and non-speech hallucination measures.
`aggregate_results.py` first aggregates fixtures within scenarios and then
computes an equal-weight scenario macro. It preserves individual repetitions,
excludes warm-ups from aggregates, applies CER/RTF/RSS hard gates before
material-benefit evaluation, and emits Pareto inputs rather than a weighted
winner score.
