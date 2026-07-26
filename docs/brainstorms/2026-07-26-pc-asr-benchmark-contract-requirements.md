---
date: 2026-07-26
topic: pc-asr-benchmark-contract
---

# PC ASR Benchmark Contract Requirements

## Summary

Define a versioned, target-specific PC ASR benchmark that compares sherpa-onnx
model families fairly, separates core recognition from product-pipeline effects,
and selects a winner only when its measured benefit justifies its runtime,
resource, and delivery costs.

---

## Problem Frame

The current macOS decision compares Zipformer 14M against native FunASR
Paraformer on one repeated five-minute Mandarin fixture. It records enough
evidence to select the first product engine, but it does not establish a broad
sherpa-onnx model shootout. The committed sherpa-onnx Paraformer results belong
to an Android emulator and are explicitly screening-only.

The current ASR gate observes aggregate CER and RTF, while the actual product
depends on difficult meeting conditions, accurate terms and numbers, usable
timestamps, predictable tail latency, bounded memory, cancellation, offline
operation, and distributable artifacts. Different model families also have
different valid configuration surfaces, so neither a universal parameter set
nor unconstrained “best settings” produces a complete fair comparison.

Relevant existing evidence and boundaries:

- `benchmark/desktop/README.md`
- `benchmark/desktop/desktop_benchmark_contract.json`
- `benchmark/desktop/desktop_model_candidates.json`
- `benchmark/desktop/MACOS_ENGINE_SELECTION.md`
- `benchmark/asr_benchmark_results_2026-07-05.md`
- `docs/solutions/architecture-patterns/desktop-first-workstation-boundaries.md`

Official model configuration sources:

- [sherpa-onnx Paraformer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html)
- [sherpa-onnx Zipformer transducer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)
- [sherpa-onnx FunASR Nano models](https://k2-fsa.github.io/sherpa/onnx/funasr-nano/pretrained.html)
- [sherpa-onnx FireRedASR models](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/pretrained.html)

---

## Actors

- A1. Benchmark maintainer: admits candidates, freezes fixtures and profiles,
  executes runs, and publishes bounded evidence.
- A2. Evidence validator: rejects target, artifact, configuration, fixture,
  metric, or gate drift without interpreting prose.
- A3. Selection reviewer: compares only validated evidence and records why a
  candidate was selected, rejected, or retained for a later round.
- A4. Product maintainer: consumes the frozen winner and its verified product
  profile without exposing benchmark tuning knobs to users.

---

## Key Flows

- F1. Candidate admission
  - **Trigger:** A model is proposed for the PC comparison.
  - **Actors:** A1, A2
  - **Steps:** Confirm product-relevant language/domain, license disposition,
    model contents and hashes, supported runtime lane, documented configuration
    source, and successful offline smoke decode.
  - **Outcome:** The candidate is admitted to Stage 1 or receives a terminal,
    machine-readable rejection reason.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Controlled and recommended quality comparison
  - **Trigger:** A candidate passes admission.
  - **Actors:** A1, A2
  - **Steps:** Tune only on the development fixtures, freeze profiles, run the
    fixed-resource core-ASR profile and recommended end-to-end profile on the
    held-out suite, then validate all metric and evidence fields.
  - **Outcome:** Comparable core and product-pipeline scorecards exist without
    test-set tuning.
  - **Covered by:** R6, R7, R8, R9, R10, R11, R12, R16, R17

- F3. Finalist operational gate
  - **Trigger:** A candidate demonstrates a preregistered material benefit in the
    held-out quality suite.
  - **Actors:** A1, A2
  - **Steps:** Run cold, warm, long-duration, resource, cancellation,
    determinism, offline, and cleanup probes on the reference target.
  - **Outcome:** The candidate either becomes an operationally admissible
    finalist or fails with explicit evidence.
  - **Covered by:** R13, R14, R15, R16, R18

- F4. Selection freeze
  - **Trigger:** All admitted candidates have a terminal Stage 1, 2, or 3
    disposition.
  - **Actors:** A2, A3, A4
  - **Steps:** Apply hard gates first, compare remaining candidates against the
    frozen Zipformer 14M baseline, review the Pareto trade-offs, and bind the
    winner, product profile, and evidence hashes.
  - **Outcome:** A machine-verifiable selection or an explicit decision to retain
    the current baseline.
  - **Covered by:** R18, R19

---

## Requirements

**Target and candidate identity**

- R1. Every result must be valid only for the recorded OS, OS version,
  architecture, CPU, logical core count, memory, runtime build, provider,
  candidate artifacts, configuration profile, fixtures, and scoring rules.
  Android evidence must not satisfy a macOS gate, and macOS evidence must not
  satisfy a Windows gate.
- R2. The first macOS round must include:
  - the current `sherpa-streaming-zipformer-zh-14m-2023-02-23` baseline;
  - `sherpa-onnx-paraformer-zh-int8-2025-10-07` as the exact mobile-parity and
    Sichuan/Chongqing candidate;
  - one pinned general Mandarin/Chinese-English sherpa-onnx Paraformer int8
    model so the dialect-specialized model does not represent the whole family;
  - `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`;
  - `sherpa-onnx-funasr-nano-int8-2025-12-30`;
  - `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25`; and
  - native FunASR 1.3.22 Paraformer with its VAD and punctuation models as a
    historical cross-runtime control in the short quality stage.
- R3. A same-runtime ranking lane must use one pinned sherpa-onnx runtime build
  for every candidate. If a candidate requires a runtime upgrade, the baseline
  and all candidates compared with it must be rerun under that upgraded build;
  results from different runtime builds must not be ranked as one lane.
- R4. Evidence and reports must distinguish native FunASR Paraformer,
  sherpa-onnx Paraformer model identities, and sherpa-onnx FunASR Nano. The
  unqualified labels “FunASR” and “Paraformer” are not sufficient candidate IDs.
- R5. Candidate admission must fail before performance ranking when the exact
  model/runtime files cannot be hash-pinned, offline operation is unavailable,
  license or redistribution disposition is not acceptable for the intended
  lane, required APIs are absent, or a smoke decode fails.

**Configuration fairness**

- R6. Each sherpa-onnx candidate must have a `recommended` profile derived from
  its official model page or API documentation. Evidence must record the source
  URL, retrieval date, sherpa-onnx version, full effective configuration,
  provider, thread allocation, model precision, prompts, language/ITN/hotword
  controls, decoder settings, VAD settings, and random seed where applicable.
- R7. Each same-runtime candidate must also have a `fixed-resource` core-ASR
  profile using the same reference machine, CPU provider, two inference threads,
  concurrency of one, decoded PCM, fixed speech segments, warm-up policy,
  measurement boundaries, and int8 artifacts where an official int8 candidate
  exists. Unsupported controls must be recorded as not applicable rather than
  silently emulated.
- R8. Core-ASR and end-to-end pipeline results must be separate scorecards.
  Core-ASR uses frozen input segments and scores raw recognizer output.
  End-to-end uses the candidate’s frozen recommended VAD, endpointing,
  punctuation, ITN, prompt, and hotword behavior and scores product-visible
  output. A pipeline component must not be credited to the acoustic model.
- R9. A `product-finalist` profile may be tuned only after Stage 2 qualification.
  Tuning must use the development fixtures, freeze before held-out execution,
  and record every deviation from the official recommended profile. Held-out
  results must be invalidated if their configuration was changed after any
  held-out transcript or metric was inspected.

**Fixtures and scoring**

- R10. The contract must define four disjoint fixture roles:
  - smoke fixtures for compatibility only;
  - development fixtures for configuration selection;
  - held-out quality fixtures for ranking; and
  - a fixed 7,200-second meeting fixture for finalist resource and reliability
    gates.
  Audio, references, scenario labels, provenance, allowed use, and SHA-256 values
  must be frozen before ranked execution.
- R11. The held-out quality suite must cover, at minimum, clean near-field
  Mandarin, far-field/noisy meetings, dialect/accent, Chinese-English
  code-switching, terminology and numeric expressions, silence/music/non-speech,
  and multi-segment long-form speech. Results must be reported per scenario and
  as a macro average so a long or easy subset cannot dominate the selection.
- R12. Scoring must use two frozen views:
  - lexical accuracy, with Unicode normalization, Latin case folding, whitespace
    normalization, and punctuation excluded; and
  - display accuracy, which evaluates punctuation and inverse text normalization
    separately.
  The lexical scorecard must include CER or WER as appropriate, substitutions,
  deletions, insertions, exact-utterance rate, terminology recall, numeric-event
  accuracy, code-switch results, and non-speech hallucination characters per
  minute. The display scorecard must include punctuation precision/recall/F1 and
  ITN event accuracy.

**Performance, resources, and reliability**

- R13. Performance evidence must separate recognizer/model load time, first-use
  end-to-end latency, warm decode-only RTF, warm end-to-end RTF, and per-segment
  latency P50/P95/P99. Streaming candidates must additionally report time to
  first partial, first final, endpoint latency, and queue/drop counts.
- R14. Resource and delivery evidence must include model archive bytes,
  extracted model bytes, packaged application/runtime increment, temporary-disk
  peak, absolute and incremental peak process RSS, RSS retained after unload,
  CPU time, configured and observed thread count, and combined ASR-plus-required-
  pipeline peak RSS. Energy and thermal data are diagnostic rather than a hard
  cross-platform gate in the first contract.
- R15. Reliability evidence must cover crash, timeout, OOM, empty output,
  non-finite metrics, two-hour completion, cancellation latency, descendant
  process termination, absence of partial publication, temporary-artifact
  cleanup, repeated-run transcript determinism, malformed/short/silent input,
  and operation with processing network access denied. Generative candidates
  must use a frozen seed and separately report hallucination and repeated-run
  variance.
- R16. Ranked performance runs must use at least one unmeasured warm-up followed
  by five measured repetitions per short profile, with candidate/profile order
  rotated or randomized. Reports must preserve every run and publish median,
  P95 where meaningful, and dispersion; cold and warm measurements must never be
  pooled. The long two-hour probe requires one full passing run and a repeat when
  any measured hard metric is within 10% of its limit.

**Evidence and decisions**

- R17. Evidence must be bounded, privacy-preserving JSON with a versioned schema
  and content-hashed index. It must bind the contract, target fingerprint,
  runtime and component hashes, candidate and component hashes, license
  disposition, effective profile and configuration source, fixture/reference
  hashes, scoring-rule version, individual-run measurements, aggregate metrics,
  gate results, and raw-output hashes. It must not contain audio/PCM,
  embeddings/voiceprints, secrets, user-home paths, or absolute file paths.
- R18. Evaluation must use a staged funnel:
  - Stage 0 rejects compatibility, identity, license, offline, or smoke failures;
  - Stage 1 runs the short fixed-resource and recommended profiles and removes
    candidates with clear quality, hallucination, RTF, or memory failure;
  - Stage 2 runs the complete held-out quality suite and promotes only candidates
    meeting the preregistered material-benefit rule; and
  - Stage 3 runs product-finalist and two-hour operational gates only for
    promoted candidates.
  Every admitted candidate must end with a terminal disposition and reasons.
- R19. Selection must apply hard gates before trade-off review. The existing
  absolute ASR safety gates of CER at most 0.35 and RTF at most 0.5 remain, and
  finalist ASR incremental peak RSS must not exceed 2 GiB on the Apple M2
  16-GiB reference target. Before held-out execution, a pilot on development
  data must freeze material-benefit margins; the initial proposal is at least a
  15% relative macro lexical-error reduction across two hard scenarios, or at
  least a 10-percentage-point terminology/numeric-event gain, with no more than
  a 5% relative clean-Mandarin regression. A candidate that passes hard gates
  but does not deliver a preregistered material benefit must not replace
  Zipformer 14M. Among material-benefit finalists, selection must use an
  explicit Pareto review of quality, latency, memory, footprint, reliability,
  and delivery cost rather than an opaque weighted total.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given a passing Android result for
  `sherpa-onnx-paraformer-zh-int8-2025-10-07`, when the macOS decision is
  evaluated, that result is prior screening context only and the exact model is
  rerun on the macOS reference target.
- AE2. **Covers R3.** Given FunASR Nano requires a newer sherpa-onnx runtime than
  the current baseline lane, when it is tested, Zipformer 14M is rerun on the
  same newer runtime and the new results form a separate comparison lane.
- AE3. **Covers R6, R7, R8.** Given official Paraformer and FunASR Nano examples
  expose different valid controls, when they are compared, each receives its
  documented recommended profile while both also run the two-thread frozen-
  segment core profile.
- AE4. **Covers R8, R12.** Given a candidate emits punctuation and ITN natively,
  when lexical CER is calculated, punctuation is excluded and ITN is not allowed
  to hide word recognition errors; punctuation and numeric rendering are scored
  in the display scorecard.
- AE5. **Covers R9, R10.** Given a configuration change is made after a held-out
  transcript is inspected, when evidence validation runs, the held-out result is
  rejected and must be regenerated under a newly frozen contract revision.
- AE6. **Covers R15, R16.** Given FunASR Nano uses a fixed seed, when the same
  silent and speech fixtures are decoded repeatedly, transcript variance and
  hallucination metrics are recorded even if aggregate CER passes.
- AE7. **Covers R18, R19.** Given a candidate improves terminology recall by 12
  percentage points but exceeds the 2-GiB incremental RSS hard gate, when
  selection runs, it is rejected before Pareto review.
- AE8. **Covers R19.** Given every candidate passes absolute gates but none meets
  the frozen material-benefit margin, when the round closes, Zipformer 14M
  remains selected and every candidate receives a cost-or-benefit disposition.

---

## Success Criteria

- The same candidate, profile, fixtures, and target can be rerun by another
  maintainer and produce an evidence package accepted by the same validator.
- A reviewer can distinguish model quality, segmentation/pipeline quality, and
  hardware/runtime allocation without consulting informal notes.
- Every first-round candidate receives a target-specific, machine-readable
  disposition; no Android result is silently promoted to a PC conclusion.
- The selected model either demonstrates a preregistered product-relevant
  benefit that justifies its costs or the current Zipformer 14M baseline is
  retained.
- Planning can implement the runner, schema, fixture preparation, scoring, and
  validators without inventing candidate roles, profile semantics, metric
  families, stage transitions, or selection behavior.

---

## Scope Boundaries

- This requirements document defines the macOS benchmark and evidence contract;
  it does not produce new model measurements.
- Windows must execute a separate target-specific contract and cannot inherit
  macOS PASS results.
- The first round does not reopen diarization model selection or change the
  frozen speaker pipeline.
- Moonshine and SenseVoice remain deferred candidates unless first-round results
  reveal an uncovered product need they specifically address.
- Cloud ASR, GPU-only models, user-selectable model switching, and UI work are
  outside this benchmark round.
- Benchmark success does not change the production model automatically; product
  capability changes require a separately frozen selection manifest and normal
  product verification.
- The corpus must use redistributable, consented, or internally recordable
  fixtures and must not commit private meeting audio.

---

## Key Decisions

- Dual-profile fairness: recommended profiles measure attainable documented
  behavior; fixed-resource profiles isolate efficiency and core recognition.
- Separate scorecards: core-ASR and end-to-end pipeline quality answer different
  questions and must not be collapsed.
- Exact mobile Paraformer plus general Paraformer: the 2025-10-07 model preserves
  mobile continuity but is dialect-specialized.
- Same-runtime lanes: runtime upgrades can affect every candidate, so a baseline
  rerun is mandatory.
- Staged execution: expensive long-duration tests are reserved for candidates
  that demonstrate held-out value.
- Hard gates plus Pareto review: fatal product failures cannot be averaged away,
  and justified trade-offs remain visible.
- Conservative default: absence of a material product benefit means retaining
  Zipformer 14M.

---

## Dependencies / Assumptions

- The Apple M2, arm64, 16-GiB machine remains the first macOS reference target.
- A general Mandarin/Chinese-English Paraformer int8 model will be selected and
  pinned during planning from the official sherpa-onnx model list.
- Fixture acquisition, annotation, and licensing are available before ranked
  execution; development and held-out references are reviewed independently.
- The existing worker-process isolation, cancellation, hash-pinning, and bounded
  evidence conventions remain authoritative.
- The proposed relative-improvement margins are initial defaults. The benchmark
  owner may revise them using development-only pilot evidence, but must freeze
  them in a versioned contract before any held-out output is inspected.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10, R11][Needs research] Which redistributable or internally recorded
  fixtures will satisfy each scenario while preserving reference quality and
  privacy?
- [Affects R12][Technical] Which existing scoring utilities can produce the
  frozen lexical, display, terminology, numeric-event, and hallucination metrics
  without divergent normalization implementations?
- [Affects R14, R16][Technical] What target-native sampler will capture short
  RSS/CPU peaks accurately without materially perturbing inference?
- [Affects R17][Technical] Should the expanded evidence extend schema version 1
  in place or introduce a parallel ASR comparison schema that is later bound by
  the product selection manifest?

