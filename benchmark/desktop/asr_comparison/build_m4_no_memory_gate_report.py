#!/usr/bin/env python3
"""Build the privacy-safe M4 ASR decision revision without a memory hard gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from build_m4_decision_report import _compact_aggregate, _table


QWEN3 = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
FUNASR = "sherpa-onnx-funasr-nano-int8-2025-12-30"
ZH_PREVIOUS = "sherpa-onnx-paraformer-zh-2024-03-09"
EN_PREVIOUS = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def _qwen_stage(
    root: Path,
    stage: str,
    language: str,
    *,
    experiment_sha256: str,
    selection_policy: dict[str, Any],
) -> dict[str, Any]:
    summary = _load(root / stage / language / "summary.json")
    expected_measured_runs = {
        "stability": 5,
        "development": 25,
        "held_out": 25,
        "operational": 1,
    }
    if (
        summary["kind"] != "m4_qwen3_asr_formal_evidence"
        or summary["stage"] != stage
        or summary["candidateId"] != QWEN3
        or summary["languageLane"] != language
        or summary["profileId"] != "fixed-resource"
        or not summary["rankEligible"]
        or summary["experimentManifestSha256"] != experiment_sha256
        or summary["selectionPolicy"] != selection_policy
        or summary["aggregate"]["measuredRunCount"]
        != expected_measured_runs[stage]
    ):
        raise ValueError(f"invalid Qwen3 {stage}/{language} evidence")
    return _compact_aggregate(summary["aggregate"], language)


def _funasr_development(path: Path, language: str) -> dict[str, Any]:
    summary = _load(path)
    aggregate = summary["aggregates"][0]
    if (
        aggregate["candidateId"] != FUNASR
        or summary["languageLane"] != language
    ):
        raise ValueError(f"invalid FunASR {language} development evidence")
    return _compact_aggregate(aggregate, language)


def build_report(
    *,
    previous: dict[str, Any],
    revision: dict[str, Any],
    freeze: dict[str, Any],
    qwen_root: Path,
    funasr_zh_path: Path,
    funasr_en_path: Path,
) -> dict[str, Any]:
    qwen = {
        stage: [
            _qwen_stage(
                qwen_root,
                stage,
                language,
                experiment_sha256=freeze["bindings"][
                    "candidateExperimentSha256"
                ],
                selection_policy=revision["selectionPolicy"],
            )
            for language in ("zh", "en")
        ]
        for stage in ("stability", "development", "held_out", "operational")
    }
    funasr = [
        _funasr_development(funasr_zh_path, "zh"),
        _funasr_development(funasr_en_path, "en"),
    ]
    qwen_held_out = {
        row["languageLane"]: row["lexicalErrorRate"]
        for row in qwen["held_out"]
    }
    previous_held_out = {
        (row["languageLane"], row["candidateId"]): row["lexicalErrorRate"]
        for row in previous["heldOut"]
    }
    if not (
        qwen_held_out["zh"] < previous_held_out[("zh", ZH_PREVIOUS)]
        and qwen_held_out["en"] < previous_held_out[("en", EN_PREVIOUS)]
    ):
        raise ValueError("Qwen3 does not support the declared held-out decision")
    dispositions = [
        value
        for value in previous["candidateDispositions"]
        if value["candidateId"] != FUNASR
    ]
    dispositions.extend(
        [
            {
                "languageLane": "zh",
                "candidateId": FUNASR,
                "disposition": "REJECTED_DEVELOPMENT_DOMINATED",
                "reason": (
                    "memory gate removed; development CER 17.92% is worse "
                    "than Qwen3 15.06% and Paraformer 15.56%"
                ),
            },
            {
                "languageLane": "en",
                "candidateId": FUNASR,
                "disposition": "REJECTED_QUALITY_GATE",
                "reason": (
                    "memory gate removed; development WER 48.79% exceeds 35%"
                ),
            },
            {
                "languageLane": "zh",
                "candidateId": QWEN3,
                "disposition": "RECOMMENDED",
                "reason": "held-out CER 11.22% versus previous winner 14.42%",
            },
            {
                "languageLane": "en",
                "candidateId": QWEN3,
                "disposition": "RECOMMENDED",
                "reason": "held-out WER 25.14% versus previous winner 32.86%",
            },
        ]
    )
    return {
        "schemaVersion": 1,
        "kind": "m4_asr_no_memory_gate_decision",
        "decisionDate": "2026-07-27",
        "policy": revision["selectionPolicy"],
        "recommendations": {
            "zh": QWEN3,
            "en": QWEN3,
            "singleModel": QWEN3,
            "productDefaultChanged": False,
        },
        "stability": previous["stability"] + qwen["stability"],
        "development": previous["development"] + funasr + qwen["development"],
        "heldOut": previous["heldOut"] + qwen["held_out"],
        "operational": previous["operational"] + qwen["operational"],
        "candidateDispositions": dispositions,
        "reliability": {
            "existingOrchestratorProbes": previous["reliability"],
            "qwen3LongOutputCompatibility": {
                "status": "PASS",
                "issue": (
                    "sherpa-onnx 1.13.4 emitted literal control characters "
                    "inside Qwen3 result JSON"
                ),
                "mitigation": (
                    "benchmark-only parser escapes control characters only "
                    "inside JSON strings and always frees the native result"
                ),
            },
        },
        "streaming": {
            "candidateId": QWEN3,
            "support": "unsupported",
            "firstPartialMilliseconds": "not_applicable",
            "finalLatencyMilliseconds": "not_applicable",
            "tailLatencyMilliseconds": "not_applicable",
            "reason": (
                "the pinned sherpa-onnx Dart Qwen3 integration exposes an "
                "offline recognizer and does not emit streaming partials"
            ),
        },
        "limitations": [
            (
                "English Qwen3 far-field/noise WER is 77.97% development and "
                "71.14% held-out."
            ),
            (
                "Chinese Qwen3 operational CER 15.51% is slightly worse than "
                "Paraformer operational CER 14.93% despite stronger held-out."
            ),
            (
                "Qwen3 uses about 2.8-3.0 GiB peak RSS and about 1.2-1.5 GiB "
                "retained RSS; memory is advisory, not ignored."
            ),
            (
                "Long evidence uses the shared fixed 15-second segmentation "
                "profile, not the sherpa Silero-VAD example profile."
            ),
        ],
        "bindings": {
            "policyRevisionSha256": revision["_sha256"],
            "developmentFreezeSha256": freeze["_sha256"],
            "previousDecisionSha256": previous["_sha256"],
            "qwenEvidence": {
                stage: {
                    language: _sha256(
                        qwen_root / stage / language / "summary.json"
                    )
                    for language in ("zh", "en")
                }
                for stage in ("stability", "development", "held_out", "operational")
            },
            "funasrDevelopmentZhSha256": _sha256(funasr_zh_path),
            "funasrDevelopmentEnSha256": _sha256(funasr_en_path),
        },
        "privacy": {
            "rawAudioPublished": False,
            "referenceTextPublished": False,
            "transcriptPublished": False,
            "modelFilesPublished": False,
            "absolutePathsPublished": False,
        },
    }


def _disposition_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| Language | Candidate | Disposition | Reason |",
        "|---|---|---|---|",
    ]
    lines.extend(
        "| {languageLane} | `{candidateId}` | {disposition} | {reason} |".format(
            **row
        )
        for row in rows
    )
    return "\n".join(lines)


def build_markdown(report: dict[str, Any]) -> str:
    return f"""# Apple M4 ASR Decision Revision — Memory Advisory Only

Decision date: 2026-07-27. This revision follows the user's explicit removal of
the 2 GiB memory hard gate. CER/WER and RTF remain hard gates. Peak,
incremental, and retained RSS remain mandatory advisory metrics.

This is benchmark evidence only. It does not change the product default model,
product worker, diarization, navigation, or UI.

## Revised decision

- Chinese: `{QWEN3}`. Held-out CER is 11.22%, versus 14.42% for the
  previous Paraformer winner.
- Pure English: `{QWEN3}`. Held-out WER is 25.14%, versus 32.86% for the
  previous SenseVoice winner.
- Single-model compromise: `{QWEN3}` because it wins both independent
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

{_table(report["stability"])}

Qwen3 stability is CER 6.03% Chinese and WER 8.80% English. It uses about
2.7-2.8 GiB peak RSS in this stage.

## Multi-scenario development

{_table(report["development"])}

Removing the memory gate re-admitted FunASR Nano. Its new development results
are Chinese CER 17.92% and English WER 48.79%; it was therefore not promoted to
held-out. Qwen3 development is Chinese CER 15.06% and English WER 27.71%.

Qwen3 English far-field/noise WER is 77.97% despite strong clean (12.06%),
accent-proxy (10.06%), and long-form (11.50%) results.

## Held-out

{_table(report["heldOut"])}

Qwen3 Chinese held-out CER 11.22% is a 3.20-point improvement over Paraformer
14.42%. Qwen3 English held-out WER 25.14% is a 7.72-point improvement over
SenseVoice 32.86%. English far-field/noise remains poor at 71.14% WER.

## Operational

{_table(report["operational"])}

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

{_disposition_table(report["candidateDispositions"])}

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
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--previous-decision", type=Path, required=True)
    parser.add_argument("--policy-revision", type=Path, required=True)
    parser.add_argument("--development-freeze", type=Path, required=True)
    parser.add_argument("--qwen-root", type=Path, required=True)
    parser.add_argument("--funasr-zh", type=Path, required=True)
    parser.add_argument("--funasr-en", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--output-markdown", type=Path, required=True)
    args = parser.parse_args()

    previous = _load(args.previous_decision)
    previous["_sha256"] = _sha256(args.previous_decision)
    revision = _load(args.policy_revision)
    revision["_sha256"] = _sha256(args.policy_revision)
    freeze = _load(args.development_freeze)
    freeze["_sha256"] = _sha256(args.development_freeze)
    report = build_report(
        previous=previous,
        revision=revision,
        freeze=freeze,
        qwen_root=args.qwen_root,
        funasr_zh_path=args.funasr_zh,
        funasr_en_path=args.funasr_en,
    )
    _write(
        args.output_json,
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    _write(args.output_markdown, build_markdown(report))
    print(
        json.dumps(
            {
                "zhRecommendation": report["recommendations"]["zh"],
                "enRecommendation": report["recommendations"]["en"],
                "memoryHardGate": report["policy"]["memory"]["hardGate"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
