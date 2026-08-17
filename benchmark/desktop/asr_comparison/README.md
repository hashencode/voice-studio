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

The separately versioned Apple M4 language expansion is defined by
`expanded_candidates_m4.json`. It does not mutate the frozen seven-candidate
first round. It adds English Zipformer, Moonshine v2, Whisper base.en, NeMo
Parakeet TDT, and SenseVoice, and re-reviews Streaming Zipformer 2025, FunASR
Nano, and FireRed for the language lanes they actually support. Mandarin and
English are independent rankings: Mandarin uses CER, English uses WER, and
code-switch audio is not required. A single cross-language winner is not
assumed.

The real M4 Stage 0 expansion result is published in
`expanded_stage0_results_m4.json`. Ten smoke runs were attempted, eight passed,
and two failed runtime admission. These short, local smoke fixtures prove
identity, offline execution, API/runtime compatibility, scoring, and resource
sampling only. They are not development or held-out ranking evidence.

The completed M4 Chinese and pure-English decision is published in
`M4_ASR_MODEL_DECISION_REPORT.md`, with the same privacy-safe evidence in
`m4_asr_model_decision.json`. Local authorized corpus, raw run output, models,
and runtime binaries remain under the ignored build evidence root.

The desktop product convergence and future optimization anchor are
`PC_QWEN3_OPTIMIZATION_BASELINE.md` and
`pc_qwen3_optimization_baseline.json`. They select one product ASR profile,
bind the reports and model hashes below, and keep the faster ORT 1.24.4 lane as
a diagnostic optimization candidate until it passes product gates.

The later user-authorized revision removes the 2 GiB memory hard gate while
continuing to require peak, incremental, and retained RSS measurements. Its
current decision is published in `M4_ASR_NO_MEMORY_GATE_DECISION_REPORT.md`
and `m4_asr_no_memory_gate_decision.json`. The earlier report remains frozen
historical evidence.

The independent Apple M4 reproduction of sherpa-onnx's published Qwen3-ASR
`Obama.wav` RTF is in `M4_QWEN3_OFFICIAL_RTF_REPRODUCTION_REPORT.md`, with
privacy-safe per-run evidence in
`m4_qwen3_official_rtf_reproduction.json`. It compares native C++ runtime
variants, the current Dart worker's fixed 15-second segmentation, official
Silero VAD segmentation, threads, resource sampling, and result conversion.
It is diagnostic-only and does not change the selected model or frozen ranking.

Reproducing it requires the official Obama WAV, Silero VAD, Qwen3-ASR int8
model, three official macOS arm64 shared runtime archives, and locally built
benchmark tools under the ignored
`build/desktop_asr_comparison/m4/official-rtf-repro` tree. Do not commit those
assets. Keep each original archive/extraction unchanged; if macOS provenance
enforcement terminates the downloaded binaries, execute a separate locally
ad-hoc-signed copy. The runner records the archive, original artifacts, and
exact executed CLI/dylib hashes independently.

From the repository root, after preparing those local-only prerequisites, run:

```bash
python3 tool/build_cache_guard.py
benchmark/desktop/asr_comparison/environment/.venv/bin/python \
  benchmark/desktop/asr_comparison/run_qwen3_official_rtf_reproduction.py
python3 tool/build_cache_guard.py
benchmark/desktop/asr_comparison/environment/.venv/bin/python \
  benchmark/desktop/asr_comparison/build_m4_qwen3_official_rtf_reproduction_report.py
```

Each runner invocation creates a new execution identity and requires every Dart
record to be freshly executed (`resumed=false`). The builder rejects stale,
partial, resumed, substituted, or locally hash-mismatched evidence and verifies
that the Markdown/JSON publication IDs, bounded-evidence hashes, and complete
Markdown byte hash match. Diagnostic fixed-15 and Silero lanes each receive an
equal warm-up and then alternate their five measured runs; the builder checks
that schedule before calling the comparison controlled. Every observation
binds privacy-safe relative raw/run-record paths and hashes. The builder
revalidates those local-only records while excluding transcript and token
payloads from both published files.

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
python3 benchmark/desktop/asr_comparison/freeze_development_fixtures.py \
  --write-template
# Complete the local review receipt only after authorization, consent,
# reference, variety, and role-isolation review.
python3 benchmark/desktop/asr_comparison/freeze_development_fixtures.py \
  --freeze
# Review and activate the generated development-freeze/fixtures.json as the
# tracked fixtures.json revision before any candidate output is decoded.
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

Use the first complete development matrix only to confirm or revise the
material-benefit rule. Before held-out access, set the contract/materiality
states together to `M4_DEVELOPMENT_FROZEN_HELD_OUT_SEALED` and `FROZEN`, rerun
the development verification matrix under that exact contract, freeze the
complete development/held-out/7,200-second fixture manifest without decoding
held-out audio, then seal it:

```bash
python3 benchmark/desktop/asr_comparison/freeze_ranked_fixtures.py \
  --write-template
# A corpus maintainer completes the fixed review fields while held-out content
# remains sealed from the benchmark operator.
python3 benchmark/desktop/asr_comparison/freeze_ranked_fixtures.py \
  --freeze
# Review and activate ranked-freeze/fixtures.json as the tracked manifest.
python3 benchmark/desktop/asr_comparison/development_freeze.py \
  --check \
  --frozen-at 2026-07-26T16:00:00Z
python3 benchmark/desktop/asr_comparison/development_freeze.py \
  --publish \
  --frozen-at 2026-07-26T16:00:00Z
```

Use the actual UTC transition timestamp. The validator recomputes every
aggregate and material-benefit comparison, binds all eight candidate/profile
aggregates plus every rank-affecting source hash, preserves all terminal
candidate dispositions, and authorizes held-out decoding only when the final
verification matrix exactly matches the sealed M4 contract.

`freeze_ranked_fixtures.py` covers all 12 non-smoke entries and verifies their
PCM payloads, UTF-8 references, source and authorization records, role
assignment, development/held-out speaker-session separation, and exact
7,200-second finalist duration. Empty lexical references are allowed only for
the declared non-speech scenario. Its output contains hashes and fixed review
dispositions only; it never copies audio or reference text.

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
excludes warm-ups from aggregates, keeps CER and WER separate, applies the
language lane's lexical/RTF/RSS hard gates before material-benefit evaluation,
and emits Pareto inputs rather than a weighted winner score.

## Runtime and model assets

`runtime_lane_characterization.json` binds the resolved `sherpa_onnx 1.13.4`
Dart API and macOS runtime hashes. The installed API exposes the required
streaming Transducer, offline Paraformer, FunASR Nano, and FireRedASR2 CTC
configuration types, so this implementation does not create an upgraded lane.
Any future runtime upgrade still requires a fresh Zipformer baseline in that
new lane.

The expansion characterizes four additional adapters exposed by the same
installed API: Whisper, Moonshine v2, NeMo offline Transducer, and SenseVoice.
Moonshine v2's `.ort` encoder and Streaming Zipformer 2025's graph metadata
failed against the currently bound native runtime and therefore remain Stage 0
failures. Accepting model terms does not override a runtime incompatibility.

`prepare_assets.py` reports which frozen candidates have complete hashes and
license admission, then verifies locally provisioned components into an atomic
build-cache tree. It never treats a pending hash or license review as admitted.
`desktop_asr_candidate_worker.dart` is benchmark-only; it validates candidate,
source, model-role, hash, and effective-profile identities before loading the
native runtime and emits bounded JSONL observations with explicit unload
events. FunASR Nano's tokenizer directory is tree-hashed and sandbox-contained;
the directory is never accepted as an unverified path.

Validate the expansion and its worker contracts with:

```bash
python3 benchmark/desktop/asr_comparison/expanded_round.py
cd benchmark/desktop/asr_comparison
environment/.venv/bin/python -m unittest \
  test_expanded_round.py \
  test_run_expanded_stage0.py \
  test_aggregate_results.py
```

`run_expanded_stage0.py` executes one candidate/language pair at a time and
requires explicit local model, runtime, tool, audio, reference, and output
roots. Model archives, tokenizer files, audio, references, raw events, and
absolute paths remain under the ignored build root. The committed result
contains bounded metrics and terminal failure codes only.

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

`freeze_development_fixtures.py` creates the private review template and, only
after every fixed assertion is completed, verifies the four local PCM/reference
pairs and atomically creates a candidate frozen manifest. Its bounded freeze
record contains hashes and review-record hashes but no audio, transcript text,
speaker identity, or absolute path. It never edits the tracked manifest
automatically; activation remains an explicit reviewed contract revision.

The benchmark Dart launcher in
`packages/desktop_sherpa_worker/tool/asr_benchmark/sandboxed_candidate_launcher.dart` reuses the
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

## Qwen3-ASR and official-parameter parity

`qwen3_experiment_m4.json` adds the sherpa-onnx Qwen3-ASR 0.6B int8 conversion
as a post-decision experiment without changing the frozen
`expanded_candidates_m4.json` set. `run_qwen3_m4_experiment.py` hash-binds its
three ONNX files and tokenizer tree, reuses the network-denied launcher, and
keeps audio, references, models, and raw observations under the ignored build
root.

The initial privacy-safe same-audio parity results are in
`M4_ASR_OFFICIAL_PARAMETER_PARITY_REPORT.md` and
`m4_asr_official_parameter_parity.json`. They combine the frozen formal model
tables with a non-ranked same-audio experiment: one warm-up plus five measured
runs for the recommended and fixed-resource profiles.

Qwen3 subsequently completed independent Chinese and pure-English five-minute
stability, five-scenario development, frozen held-out, and one-hour-class
operational stages. Under the revision with memory as an advisory metric, it is
the held-out recommendation for both languages and the single-model
compromise. See `M4_ASR_NO_MEMORY_GATE_DECISION_REPORT.md`; this benchmark
decision does not switch the product model.
