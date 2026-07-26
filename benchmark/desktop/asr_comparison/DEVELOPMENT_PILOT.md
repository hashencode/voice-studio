# macOS ASR comparison v2 development-pilot checkpoint

Status: `BLOCKED_BEFORE_DEVELOPMENT_FREEZE`

This checkpoint records real, non-ranked candidate diagnostics. It does not
publish `development-freeze.json`, authorize held-out decoding, or recommend a
product-model change.

## Target and scope

- Executed target: macOS 15.7.5 (24G624), arm64, Apple M4, 10 logical CPUs,
  16 GiB memory.
- Frozen decision target: Apple M4. The observations below satisfy Stage 0
  reference-target admission but are not development rankings.
- Runtime lane: `sherpa-onnx-dart-1.13.4-macos-arm64`.
- Processing was launched through the benchmark sandbox. Every successful run
  required active network and user-home permission-denial probes.
- The 15-second fixture is deterministically derived from the first 15 seconds
  of the committed repetitive Chinese smoke fixture. The 300.65-second fixture
  is the existing committed repetitive smoke fixture. Neither is eligible for
  development or held-out ranking.
- Each row is one measured diagnostic run, not the frozen one-warm-up plus
  five-repetition development matrix.

## Real 15-second recommended-profile smoke

| Candidate | CER | RTF | Load ms | Decode ms | Peak RSS MiB | Incremental RSS MiB | Retained RSS MiB | Run ID |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Zipformer 14M baseline | 0.000% | 0.0188 | 105.3 | 282.5 | 115.1 | 79.6 | 101.8 | `asr2-75975ab9be3a083914c59af187b1ef24` |
| Mobile-parity Paraformer 2025-10-07 | 0.000% | 0.0431 | 655.1 | 646.9 | 614.7 | 575.8 | 601.0 | `asr2-08d3c9b862c921843e0635eac01d646a` |
| General Paraformer 2024-03-09 | 0.000% | 0.0415 | 497.6 | 622.5 | 583.2 | 547.4 | 569.4 | `asr2-3a4dd7dde70699558a6acc91c5446da9` |
| FireRedASR2 CTC | 2.000% | 0.3330 | 459.5 | 4,995.3 | 1,450.0 | 1,412.6 | 1,060.7 | `asr2-f6e2d17ad4bfa636a24f71238398d0e7` |

Retained RSS uses the worker's bounded `ProcessInfo.currentRss` unload event
when the sandbox process chain has already detached from the sampler's original
parent tree. The resource record names this source as `worker_self_report`;
false zero values are not accepted.

## Real 300.65-second fixed-resource smoke

| Candidate | Disposition | CER | RTF | Load ms | Decode ms | Peak RSS MiB | Incremental RSS MiB | Retained RSS MiB | Run ID |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Zipformer 14M baseline | Success | 5.621% | 0.0088 | 106.8 | 2,638.0 | 190.8 | 157.5 | 178.0 | `asr2-04b3e7f1407a79f42ce9dbeb00c05e66` |
| Mobile-parity Paraformer 2025-10-07 | Success | 9.566% | 0.0419 | 633.9 | 12,598.4 | 483.5 | 443.7 | 470.3 | `asr2-8942c0268406204ce945e607b98a0b8a` |
| General Paraformer 2024-03-09 | Success | 1.085% | 0.0415 | 503.4 | 12,476.8 | 597.6 | 563.4 | 585.9 | `asr2-265e8bc82aad272d05a1d9221a10c3de` |
| FireRedASR2 CTC | Success | 3.945% | 0.3327 | 502.6 | 100,032.4 | 1,371.4 | 1,330.8 | 1,104.9 | `asr2-e95ae68355ec5265cbe1fd14e3a9919a` |

The earlier FireRed whole-file diagnostic terminated in ONNX Runtime because
the graph could not broadcast the full 300-second sequence shape. The contract
now freezes candidate-independent 15-second fixed-resource segments. All four
candidates completed the same 300.65-second input under that schedule.

## Candidate dispositions

| Candidate | Current v2 disposition | Why |
|---|---|---|
| Zipformer 14M baseline | `ADMITTED` | Frozen-target M4 Stage 0 passed with active sandbox denial probes. |
| Mobile-parity Paraformer | `ADMITTED` | Exact mobile graph passed frozen-target M4 Stage 0. Android results remain screening-only. |
| General Paraformer | `ADMITTED` | Pinned graph and tokens passed frozen-target M4 Stage 0. |
| Streaming Zipformer 2025-06-30 | `REJECTED_LICENSE` | Archive/components are pinned, but upstream gated terms were not accepted on the user's behalf. |
| sherpa FunASR Nano | `REJECTED_LICENSE` | Archive/components are pinned, but the converted model has no exact license notice; the tokenizer license is insufficient. |
| FireRedASR2 CTC | `ADMITTED` | Frozen-target M4 Stage 0 passed; common 15-second segmentation completed the 300.65-second smoke. |
| Native FunASR 1.3.22 | `CROSS_RUNTIME_CONTROL_COMPLETE` | Historical M2 Stage 1 control only: CER 11.6371%, RTF 0.202825. It is excluded from sherpa Stage 2/3 ranking. |

Native FunASR stays in the frozen registry so the first-round audit retains all
seven identities and a machine-readable terminal disposition. It is not queued
for another same-runtime test.

## Development-freeze blockers

`development-freeze.json` is intentionally absent. The following prerequisites
remain unmet:

1. Provide and review the authorized local-only development fixtures:
   Common Voice clean, AISHELL-4 far-field, consented dialect, and consented
   scripted terms/numbers/code-switch audio. Their hashes, references, license
   or consent records, and group-leakage metadata are still pending.
2. Complete the one-warm-up plus five-measured-repetition development matrix
   under both profiles, then freeze target, lane, profile, scorer, fixture,
   reference, seed, and materiality hashes.

`development_matrix.py` now executes that matrix, while
`development_freeze.py` requires a final verification run under the paired
`M4_DEVELOPMENT_FROZEN_HELD_OUT_SEALED` / `FROZEN` states and recomputes every
aggregate and comparison before it can publish the freeze. It also requires
the complete development, held-out, and 7,200-second fixture manifest to be
hash-pinned and reviewed before authorizing held-out access. These tools do not
waive either missing prerequisite above.

Held-out transcripts remain inaccessible, and no U8 held-out ranking or
7,200-second finalist run has been performed.
