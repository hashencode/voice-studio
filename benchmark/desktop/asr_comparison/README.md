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

U1-U6 tooling is complete. U7 has real Apple M4 Stage 0 admission and common
fixed-resource segmentation diagnostics recorded in `DEVELOPMENT_PILOT.md`.
Authorized development fixtures remain unavailable. A ranked development
freeze, held-out output, candidate ranking, and the two-hour finalist gate have
not been run.

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

After the four reviewed development entries are frozen, prepare and preflight
the real M4 matrix with:

```bash
python3 benchmark/desktop/asr_comparison/prepare_fixtures.py \
  --development \
  --output build/desktop_asr_comparison/fixtures/development-active
python3 benchmark/desktop/asr_comparison/development_matrix.py --preflight
```

Before the real matrix, run `python3 tool/build_cache_guard.py`, then replace
`--preflight` with `--execute`. The executor admits only the four current
sherpa candidates, resolves model components from the atomic ignored asset
cache, schedules one warm-up plus five measured repetitions per
candidate/profile/fixture, and writes aggregates only after every sandboxed run
completes. Development output is explicitly not held-out ranking evidence.

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

## Runtime and model assets

`runtime_lane_characterization.json` binds the resolved `sherpa_onnx 1.13.4`
Dart API and macOS runtime hashes. The installed API exposes the required
streaming Transducer, offline Paraformer, FunASR Nano, and FireRedASR2 CTC
configuration types, so this implementation does not create an upgraded lane.
Any future runtime upgrade still requires a fresh Zipformer baseline in that
new lane.

`prepare_assets.py` reports which frozen candidates have complete hashes and
license admission, then verifies locally provisioned components into an atomic
build-cache tree. It never treats a pending hash or license review as admitted.
`desktop_asr_candidate_worker.dart` is benchmark-only; it validates candidate,
source, model-role, hash, and effective-profile identities before loading the
native runtime and emits bounded JSONL observations with explicit unload
events.

## Orchestration and bounded evidence

`run_macos_asr_comparison.py` owns deterministic Stage 0–3 scheduling,
hash-bound run identities, fresh process execution, process-tree resource
sampling, timeout/cancellation, partial-run quarantine, and resume. Its
`--fake-smoke` mode is intentionally non-ranked and executes one warm-up plus
five measured runs against the committed smoke fixture.

`development_matrix.py` is the fail-closed U7 execution entry. It binds the
Apple M4 fingerprint, shared sherpa runtime, worker, candidate registry,
profiles, fixture/reference hashes, scorer, and prepared model components
before decoding. Native FunASR and license-rejected candidates cannot enter its
schedule.

The benchmark Dart launcher in
`apps/desktop/tool/asr_benchmark/sandboxed_candidate_launcher.dart` reuses the
desktop sidecar roots/profile and enters the native process-group launcher. It
fails closed unless active network and user-home probes both produce a
permission denial; connection refusal is not accepted as proof.

`reliability_probes.py` exercises crash, timeout, simulated OOM, empty output,
malformed input/output, short and silent fixtures, seeded determinism,
TERM-resistant descendants, temporary cleanup, and sandboxed offline
completion. `validate_evidence.py` rejects private or unbounded payloads before
content-addressed atomic activation. The committed result is documented in
`benchmark/desktop/evidence/macos-asr-comparison-v2/README.md`.

Native FunASR remains a locked cross-runtime short-stage control through
`native_funasr_adapter.py`; it is never admitted into a same-runtime sherpa
ranking lane.
