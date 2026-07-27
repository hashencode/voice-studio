#!/usr/bin/env python3
"""Build the privacy-safe official-metric and parameter-parity supplement."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from build_m4_decision_report import _compact_aggregate, _table


OFFICIAL_REFERENCES = [
    {
        "candidateId": "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        "reportedMetric": "Open ASR Leaderboard mean WER",
        "reportedValue": 0.0631,
        "sourceUrl": "https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf",
        "comparability": "not_directly_comparable",
        "reason": (
            "The upstream number uses different datasets, the original model "
            "runtime, and its own normalization; this experiment uses a "
            "sherpa-onnx int8 conversion and local FLEURS fixtures."
        ),
    },
    {
        "candidateId": "sherpa-onnx-whisper-base-en-int8-2023-01-31",
        "reportedMetric": "LibriSpeech test-clean WER",
        "reportedValue": 0.04271,
        "sourceUrl": "https://huggingface.co/openai/whisper-base.en",
        "comparability": "not_directly_comparable",
        "reason": (
            "The upstream example uses LibriSpeech test-clean and the "
            "Transformers implementation; this benchmark uses FLEURS, "
            "sherpa-onnx, int8, and fixed 15-second segmentation."
        ),
    },
    {
        "candidateId": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01",
        "reportedMetric": "model-card benchmark suite",
        "reportedValue": None,
        "sourceUrl": "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2",
        "comparability": "not_directly_comparable",
        "reason": (
            "The model card reports multiple Open ASR datasets with the native "
            "NeMo/GPU path; no single number matches this FLEURS sherpa-onnx "
            "int8 CPU lane."
        ),
    },
]


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_write(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def _measured_hashes(aggregate: dict[str, Any]) -> list[str]:
    return sorted(
        {
            run["rawOutputSha256"]
            for run in aggregate["runs"]
            if not run["warmup"]
        }
    )


def _parity_row(
    aggregate: dict[str, Any],
    language_lane: str,
    profile_id: str,
    *,
    rank_eligible: bool,
) -> dict[str, Any]:
    compact = _compact_aggregate(aggregate, language_lane)
    return {
        **compact,
        "profileId": profile_id,
        "rankEligible": rank_eligible,
        "distinctRawOutputCount": len(_measured_hashes(aggregate)),
        "rawOutputSha256": _measured_hashes(aggregate)[0],
    }


def _load_parity(parity_root: Path, qwen_root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for language_lane in ("zh", "en"):
        for profile_name, profile_id in (
            ("recommended", "official_or_model_recommended"),
            ("fixed", "fixed_resource"),
        ):
            summary = _load(
                parity_root / f"{language_lane}-{profile_name}" / "summary.json"
            )
            rows.extend(
                _parity_row(
                    aggregate,
                    language_lane,
                    profile_id,
                    rank_eligible=False,
                )
                for aggregate in summary["aggregates"]
            )
            qwen_summary = _load(
                qwen_root / f"{language_lane}-{profile_name}" / "summary.json"
            )
            rows.append(
                _parity_row(
                    qwen_summary["aggregate"],
                    language_lane,
                    (
                        "official_recommended"
                        if profile_name == "recommended"
                        else "fixed_resource"
                    ),
                    rank_eligible=False,
                )
            )
    return rows


def _profile_comparisons(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(
            (row["languageLane"], row["candidateId"]), []
        ).append(row)
    result = []
    for (language_lane, candidate_id), values in sorted(groups.items()):
        if len(values) != 2:
            raise ValueError(f"expected two profiles for {candidate_id}")
        metric = "cer" if language_lane == "zh" else "wer"
        rates = [value["lexicalErrorRate"] for value in values]
        hashes = [value["rawOutputSha256"] for value in values]
        result.append(
            {
                "languageLane": language_lane,
                "candidateId": candidate_id,
                "lexicalMetric": metric,
                "recommendedErrorRate": rates[0],
                "fixedResourceErrorRate": rates[1],
                "errorRateChanged": rates[0] != rates[1],
                "rawOutputChanged": hashes[0] != hashes[1],
            }
        )
    return result


def build_report(
    decision: dict[str, Any],
    parity_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    comparisons = _profile_comparisons(parity_rows)
    return {
        "schemaVersion": 1,
        "kind": "m4_asr_official_metric_and_parameter_parity_supplement",
        "date": "2026-07-27",
        "scope": {
            "targetCpuModel": "Apple M4",
            "runtimeLaneId": "sherpa-onnx-dart-1.13.4-macos-arm64",
            "parameterParityFixture": (
                "one authorized FLEURS utterance per language, <=15 seconds"
            ),
            "parameterParityRuns": "1 warm-up + 5 measured per cell",
            "rankEligible": False,
        },
        "conclusion": {
            "officialNumbersDirectlyComparable": False,
            "qualityChangedUnderRecommendedProfiles": any(
                value["errorRateChanged"] or value["rawOutputChanged"]
                for value in comparisons
            ),
            "qwen3FormalRankingStatus": (
                "short_parity_not_ranked; ranked_in_later_no_memory_gate_revision"
            ),
            "supersededForSelectionBy": (
                "m4_asr_no_memory_gate_decision.json"
            ),
            "frozenDecisionChanged": False,
        },
        "officialReferences": OFFICIAL_REFERENCES,
        "formalEvidence": {
            "stability": decision["stability"],
            "development": decision["development"],
            "heldOut": decision["heldOut"],
            "operational": decision["operational"],
            "candidateDispositions": decision["candidateDispositions"],
        },
        "parameterParity": parity_rows,
        "profileComparisons": comparisons,
        "privacy": {
            "rawAudioPublished": False,
            "referenceTextPublished": False,
            "transcriptPublished": False,
            "modelFilesPublished": False,
            "absolutePathsPublished": False,
        },
    }


def _parity_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| Language | Candidate | Profile | CER/WER | Load ms | Decode ms | E2E ms | RTF | Segment P50/P95 ms | Peak/retained MiB | Output variants |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        metric = row["lexicalMetric"].upper()
        lines.append(
            "| {languageLane} | `{candidateId}` | {profileId} | "
            "{metric} {rate:.2f}% | {load:.1f} | {decode:.1f} | {e2e:.1f} | "
            "{rtf:.4f} | {p50:.1f}/{p95:.1f} | {peak:.1f}/{retained:.1f} | "
            "{variants} |".format(
                languageLane=row["languageLane"],
                candidateId=row["candidateId"],
                profileId=row["profileId"],
                metric=metric,
                rate=row["lexicalErrorRate"] * 100,
                load=row["loadMilliseconds"]["median"],
                decode=row["decodeMilliseconds"]["median"],
                e2e=row["endToEndWallMilliseconds"]["median"],
                rtf=row["rtf"]["median"],
                p50=row["segmentLatencyP50Milliseconds"]["median"],
                p95=row["segmentLatencyP95Milliseconds"]["median"],
                peak=row["absolutePeakRssBytes"]["maximum"] / 1048576,
                retained=row["retainedRssBytesAfterUnload"]["median"] / 1048576,
                variants=row["distinctRawOutputCount"],
            )
        )
    return "\n".join(lines)


def build_markdown(report: dict[str, Any]) -> str:
    return f"""# Apple M4 ASR Official-Metric and Parameter-Parity Supplement

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
  identical output hashes for all {len(report["profileComparisons"])} tested
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

{_table(report["formalEvidence"]["stability"])}

### Multi-scenario development

{_table(report["formalEvidence"]["development"])}

### Held-out

{_table(report["formalEvidence"]["heldOut"])}

### Operational

{_table(report["formalEvidence"]["operational"])}

## Same-audio parameter parity

Each cell used one authorized FLEURS utterance that fits within one 15-second
segment, one warm-up, and five measured runs. `official_or_model_recommended`
means the candidate's existing recommended profile; Qwen3 uses the explicit
sherpa defaults: CPU, 2 threads, max total/new tokens 512/512, temperature
0.000001, top-p 0.8, seed 42, and no hotwords.

{_parity_table(report["parameterParity"])}

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
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--decision-json", type=Path, required=True)
    parser.add_argument("--parity-root", type=Path, required=True)
    parser.add_argument("--qwen-root", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--output-markdown", type=Path, required=True)
    args = parser.parse_args()
    parity_rows = _load_parity(args.parity_root, args.qwen_root)
    report = build_report(_load(args.decision_json), parity_rows)
    _atomic_write(
        args.output_json,
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    _atomic_write(args.output_markdown, build_markdown(report))
    print(
        json.dumps(
            {
                "candidateLanguagePairs": len(report["profileComparisons"]),
                "parityRows": len(report["parameterParity"]),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
