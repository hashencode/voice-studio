---
date: 2026-07-26
topic: pc-asr-benchmark-contract
focus: Define a fair, reproducible PC ASR model-selection benchmark
mode: repo-grounded
---

# Ideation: PC ASR Benchmark Contract

## Grounding Context

- `benchmark/asr_benchmark_results_2026-07-05.md` records sherpa-onnx
  Paraformer results from an Android emulator and labels them screening evidence.
- `benchmark/desktop/README.md` makes platform evidence target-specific; Android
  results cannot close a macOS decision.
- `benchmark/desktop/MACOS_ENGINE_SELECTION.md` already contains a separate
  Apple M2 result for native FunASR 1.3.22 Paraformer with FSMN VAD and CT
  punctuation.
- `benchmark/desktop/desktop_benchmark_contract.json` currently admits only the
  Zipformer 14M ASR model and uses one five-minute Mandarin fixture with CER and
  RTF gates.
- Official sherpa-onnx model pages expose different model-family configuration
  surfaces. FunASR Nano has prompt, language, ITN, hotword, token-generation,
  sampling, and seed controls that do not apply to Paraformer or Zipformer.
- The mobile Paraformer model dated 2025-10-07 is fine-tuned for Sichuan and
  Chongqing speech. It is useful as a mobile-parity and dialect candidate, but
  should not represent the whole Paraformer family in a general meeting test.

## Topic Axes

- Candidate identity and platform evidence
- Configuration fairness
- Corpus and scoring quality
- Performance, resources, and reliability
- Admission and selection decisions

## Ranked Ideas

### 1. Define a versioned PC ASR benchmark contract

**Description:** Replace the current two-row comparison with a target-bound,
machine-verifiable contract covering candidate identity, configuration profiles,
fixtures, metrics, evidence, gates, and terminal dispositions.

**Axis:** Admission and selection decisions

**Basis:** `direct:` The current desktop validator already binds runtime, model,
fixture, target fingerprint, CER, RTF, resource, and cancellation evidence, but
the ASR contract has only one candidate and a narrow scorecard.

**Rationale:** A versioned contract prevents the candidate list, tuning rules,
and winner criteria from changing after results are visible.

**Downsides:** Requires benchmark tooling and evidence-schema work before new
results can be considered final.

**Confidence:** 96%

**Complexity:** High

**Status:** Explored

### 2. Use complementary recommended and fixed-resource profiles

**Description:** Run each model with its documented sherpa-onnx configuration,
then run a controlled profile with fixed provider, threads, input, segmentation,
and measurement policy. Run product tuning only for finalists and freeze it on
a development set.

**Axis:** Configuration fairness

**Basis:** `external:` Official sherpa-onnx examples use family-specific model
files and controls; FunASR Nano additionally exposes generative and prompting
parameters.

**Rationale:** Recommended-only testing confounds model efficiency with resource
allocation, while one universal parameter set can handicap model families.

**Downsides:** More runs and two scorecards instead of one result table.

**Confidence:** 95%

**Complexity:** Medium

**Status:** Unexplored

### 3. Separate core-ASR and end-to-end pipeline scorecards

**Description:** Score all models on identical frozen speech segments for the
core comparison, then score their recommended VAD, punctuation, ITN, and hotword
pipeline separately.

**Axis:** Configuration fairness

**Basis:** `direct:` Existing mobile evidence shows that VAD segmentation changes
CER, memory, segment count, and latency enough to dominate a model comparison.

**Rationale:** The split answers both “which recognizer is better?” and “which
product pipeline is better?” without mixing the two.

**Downsides:** Requires reference segmentation and separate raw/display scoring.

**Confidence:** 94%

**Complexity:** Medium

**Status:** Unexplored

### 4. Replace aggregate CER ranking with scenario scorecards

**Description:** Add clean Mandarin, far-field/noisy meetings, dialect,
Chinese-English code-switching, terminology/numbers, non-speech, and long-file
fixtures. Report macro scenario results plus substitutions, deletions,
insertions, punctuation, ITN, terminology, and hallucination measures.

**Axis:** Corpus and scoring quality

**Basis:** `direct:` The current desktop ASR decision is based on a repeated
five-minute fixture, while the product is intended for varied long meetings.

**Rationale:** A model should win because it improves the product’s difficult
cases, not because one clean or repetitive fixture dominates a pooled CER.

**Downsides:** Corpus creation and reference review are the largest manual cost.

**Confidence:** 93%

**Complexity:** High

**Status:** Unexplored

### 5. Make product cost first-class evidence

**Description:** Record cold load, warm and end-to-end RTF, tail latency, peak and
retained RSS, CPU, model/package/temp-disk size, two-hour completion,
cancellation, repeated-run determinism, and offline behavior.

**Axis:** Performance, resources, and reliability

**Basis:** `direct:` Native FunASR passed absolute CER/RTF gates but lost because
its quality did not justify Python packaging, startup, 3.13 GiB incremental RSS,
and model footprint.

**Rationale:** These are selection inputs already used informally; recording them
uniformly makes the decision auditable.

**Downsides:** Some measurements require process-level instrumentation rather
than the current end-of-probe RSS reading.

**Confidence:** 96%

**Complexity:** Medium

**Status:** Unexplored

### 6. Use a staged, Pareto-based candidate funnel

**Description:** Run compatibility/smoke checks first, a held-out quality suite
second, and expensive two-hour reliability tests only for finalists. Apply hard
admission gates before comparing quality gains against resource and delivery
costs; retain Zipformer 14M when no candidate delivers a material justified
benefit.

**Axis:** Admission and selection decisions

**Basis:** `reasoned:` A full long-duration matrix wastes time on models that are
already disqualified by runtime, license, hallucination, quality, or memory.
A single weighted score would hide why a trade-off was accepted.

**Rationale:** The funnel controls benchmark cost and produces explicit reasons
for selection or rejection.

**Downsides:** Material-improvement margins must be preregistered before the
held-out run.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|---|---|
| 1 | Reuse Android Paraformer numbers for PC | Violates the repository’s target-specific evidence boundary. |
| 2 | Treat native FunASR and sherpa-onnx Paraformer as one result | Different weights, runtimes, pipelines, and delivery costs make the label misleading. |
| 3 | Apply one configuration to every model | Model families expose materially different valid configuration surfaces. |
| 4 | Use only each model’s recommended settings | Different thread and pipeline allocations would confound efficiency comparisons. |
| 5 | Send every candidate directly to the two-hour gate | Too expensive before compatibility and quality screening. |
| 6 | Rank by one weighted total score | Weighting hides hard failures and makes cost/quality decisions difficult to audit. |
| 7 | Test only the 2025-10-07 Paraformer | It is a dialect-specialized model and is not a complete Paraformer family comparison. |

