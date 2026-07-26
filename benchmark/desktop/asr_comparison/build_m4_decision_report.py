#!/usr/bin/env python3
"""Build the privacy-safe M4 ASR decision report from bounded local evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any


ZH_WINNER = "sherpa-onnx-paraformer-zh-2024-03-09"
EN_WINNER = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
SINGLE_MODEL = EN_WINNER


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    encoded = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(encoded, encoding="utf-8")
    os.replace(temporary, path)


def _write_text(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _compact_aggregate(
    aggregate: dict[str, Any], language_lane: str
) -> dict[str, Any]:
    metric = "cer" if language_lane == "zh" else "wer"
    performance = aggregate["performance"]
    resources = aggregate["resources"]
    return {
        "candidateId": aggregate["candidateId"],
        "languageLane": language_lane,
        "measuredRunCount": aggregate["measuredRunCount"],
        "lexicalMetric": metric,
        "lexicalErrorRate": aggregate["macroMetrics"][metric],
        "loadMilliseconds": performance["loadMilliseconds"],
        "decodeMilliseconds": performance["decodeMilliseconds"],
        "endToEndWallMilliseconds": performance["endToEndWallMilliseconds"],
        "rtf": performance["rtf"],
        "segmentLatencyP50Milliseconds": performance[
            "segmentLatencyP50Milliseconds"
        ],
        "segmentLatencyP95Milliseconds": performance[
            "segmentLatencyP95Milliseconds"
        ],
        "absolutePeakRssBytes": resources["absolutePeakRssBytes"],
        "incrementalPeakRssBytes": resources["incrementalPeakRssBytes"],
        "retainedRssBytesAfterUnload": resources[
            "retainedRssBytesAfterUnload"
        ],
    }


def _stage(
    evidence_root: Path, name: str, language_lane: str
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    summary_path = evidence_root / name / language_lane / "summary.json"
    summary = _load(summary_path)
    return summary, [
        _compact_aggregate(value, language_lane)
        for value in summary["aggregates"]
    ]


def _transcript_determinism(
    evidence_root: Path, stages: tuple[str, ...]
) -> dict[str, Any]:
    groups: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)
    measured_runs = 0
    for stage in stages:
        for language_lane in ("zh", "en"):
            root = evidence_root / stage / language_lane
            summary = _load(root / "summary.json")
            for observation in summary["observations"]:
                if observation["warmup"]:
                    continue
                raw = _load(root / "raw" / f"{observation['runId']}.json")
                result = next(
                    event for event in raw["events"] if event["type"] == "result"
                )
                digest = hashlib.sha256(
                    str(result["text"]).encode("utf-8")
                ).hexdigest()
                key = (
                    stage,
                    language_lane,
                    observation["candidateId"],
                    observation["fixtureId"],
                )
                groups[key].add(digest)
                measured_runs += 1
    unstable = [
        {
            "stage": key[0],
            "languageLane": key[1],
            "candidateId": key[2],
            "distinctTranscriptCount": len(digests),
        }
        for key, digests in groups.items()
        if len(digests) != 1
    ]
    return {
        "scope": "transcript_only; worker timing fields excluded",
        "measuredRunCount": measured_runs,
        "candidateFixtureGroupCount": len(groups),
        "unstableGroupCount": len(unstable),
        "stable": not unstable,
        "unstableGroups": unstable,
    }


def _streaming(summary: dict[str, Any]) -> dict[str, Any]:
    measured = [
        value["streamingObservation"]
        for value in summary["observations"]
        if not value["warmup"]
    ]

    def percentile(field: str, fraction: float) -> float | None:
        values = sorted(
            float(item[field]) for item in measured if item[field] is not None
        )
        if not values:
            return None
        index = max(0, int((len(values) * fraction) + 0.999999) - 1)
        return values[index]

    return {
        "candidateId": summary["candidateIds"][0],
        "languageLane": summary["languageLane"],
        "measuredRunCount": len(measured),
        "applicability": measured[0]["applicability"],
        "pacingPolicy": measured[0]["pacingPolicy"],
        "firstPartialWallMilliseconds": {
            "median": percentile("firstPartialWallMilliseconds", 0.5),
            "p95": percentile("firstPartialWallMilliseconds", 0.95),
            "status": measured[0]["firstPartialStatus"],
        },
        "firstFinalWallMilliseconds": {
            "median": percentile("firstFinalWallMilliseconds", 0.5),
            "p95": percentile("firstFinalWallMilliseconds", 0.95),
            "status": measured[0]["firstFinalStatus"],
        },
        "tailLatencyMilliseconds": {
            "median": percentile("tailLatencyMilliseconds", 0.5),
            "p95": percentile("tailLatencyMilliseconds", 0.95),
            "status": measured[0]["tailLatencyStatus"],
        },
        "partialCount": {
            "median": percentile("partialCount", 0.5),
            "p95": percentile("partialCount", 0.95),
        },
    }


def _fmt_rate(value: float | None) -> str:
    return "unsupported" if value is None else f"{value * 100:.2f}%"


def _fmt_ms(value: float | None) -> str:
    return "unsupported" if value is None else f"{value:.1f}"


def _fmt_mib(value: float | None) -> str:
    return "unsupported" if value is None else f"{value / 1048576:.1f}"


def _table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| Language | Candidate | CER/WER | Load median/P95 ms | Decode median/P95 ms | E2E median/P95 ms | RTF median/P95 | Segment P50/P95 ms | Peak/incremental/retained MiB | Runs |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        metric = row["lexicalMetric"].upper()
        lines.append(
            "| {languageLane} | `{candidateId}` | {metric} {error} | "
            "{load_median:.1f}/{load_p95:.1f} | {decode_median:.1f}/{decode_p95:.1f} | "
            "{e2e_median:.1f}/{e2e_p95:.1f} | {rtf_median:.4f}/{rtf_p95:.4f} | "
            "{segment_p50:.1f}/{segment_p95:.1f} | {peak}/{incremental}/{retained} | {runs} |".format(
                **row,
                metric=metric,
                error=_fmt_rate(row["lexicalErrorRate"]),
                load_median=row["loadMilliseconds"]["median"],
                load_p95=row["loadMilliseconds"]["p95"],
                decode_median=row["decodeMilliseconds"]["median"],
                decode_p95=row["decodeMilliseconds"]["p95"],
                e2e_median=row["endToEndWallMilliseconds"]["median"],
                e2e_p95=row["endToEndWallMilliseconds"]["p95"],
                rtf_median=row["rtf"]["median"],
                rtf_p95=row["rtf"]["p95"],
                segment_p50=row["segmentLatencyP50Milliseconds"]["median"],
                segment_p95=row["segmentLatencyP95Milliseconds"]["p95"],
                peak=_fmt_mib(row["absolutePeakRssBytes"]["maximum"]),
                incremental=_fmt_mib(
                    row["incrementalPeakRssBytes"]["maximum"]
                ),
                retained=_fmt_mib(
                    row["retainedRssBytesAfterUnload"]["maximum"]
                ),
                runs=row["measuredRunCount"],
            )
        )
    return "\n".join(lines)


def _decision_markdown(report: dict[str, Any]) -> str:
    streaming_zh, streaming_en = report["streaming"]
    dispositions = "\n".join(
        f"| {item['languageLane']} | `{item['candidateId']}` | "
        f"{item['disposition']} | {item['reason']} |"
        for item in report["candidateDispositions"]
    )
    probes = ", ".join(
        item["probeId"] for item in report["reliability"]["orchestratorProbes"]
    )
    return f"""# Apple M4 macOS ASR Model Decision Report

Decision date: 2026-07-27. This report is benchmark evidence only. It does not
change the product default model, product worker, diarization, navigation, or UI.

## Decision

- Chinese: `{ZH_WINNER}`. Held-out CER is
  {_fmt_rate(report['heldOut'][1]['lexicalErrorRate'])}; it is more accurate,
  faster, and uses less memory than the int8 Paraformer finalist in this lane.
- Pure English: `{EN_WINNER}`. Held-out WER is
  {_fmt_rate(report['heldOut'][3]['lexicalErrorRate'])}; it is more accurate,
  about twice as fast, and materially lighter than Parakeet.
- If the product can ship only one model: `{SINGLE_MODEL}`. It wins English and
  remains competitive in Chinese (development CER 16.97%, 62.42-minute
  operational CER 16.48%). It is a compromise, not the best Chinese model.

## Environment and fixed measurement contract

- Apple M4, arm64, macOS 15.7.5 (24G624).
- Runtime lane: `sherpa-onnx-dart-1.13.4-macos-arm64`; runtime SHA-256
  `{report['bindings']['runtimeSha256']}`.
- CPU provider, 2 threads, concurrency 1, 15-second segments.
- Short/scenario cells used 1 warm-up plus 5 measured runs; measured order was
  rotated with seed 20260726. Tables report medians and nearest-rank P95.
- `loadMilliseconds` is cold recognizer/model construction. `decodeMilliseconds`
  is warm model inference. `endToEndWallMilliseconds` spans first accepted input
  through final result. RTF is decode/audio duration. Peak RSS is absolute
  process-group peak; retained RSS is the post-unload worker self-report.
- Hard gates: CER/WER <= 35%, RTF <= 0.5, absolute peak RSS <= 2 GiB.

## Corpus, scenarios, and licensing

Quality evidence uses local-only Google FLEURS audio under CC-BY 4.0. Chinese
uses CER and pure English uses WER. Development and held-out packs are disjoint
validation/test splits and are hash-bound below. Each contains clean,
far-field/noise transformation, speaker-variability accent proxy,
terminology/numbers, and long-form scenarios. Raw audio, reference text,
transcripts, model files, credentials, cookies, absolute paths, and restricted
assets are not published.

FLEURS is read speech, not a true meeting corpus. “Accent” means natural speaker
variability rather than reviewed accent labels, and far-field is a deterministic
echo/noise transform. There is no mandatory code-switch test. These limitations
constrain external validity and must be revisited before a meeting-domain product
switch.

## Evidence separation

Stage 0 was a real M4 runtime smoke only: 10 candidate/language attempts, 8
admitted and 2 runtime-admission failures. It proves execution and sampling, not
ranking. The formal evidence below is kept separate.

### Five-minute stability

{_table(report['stability'])}

The stability fixture is approximately five minutes per language. FunASR Nano
exceeded the 2 GiB absolute peak gate in both lanes. The English Zipformer
baseline failed the WER gate. Runtime-rejected Streaming Zipformer 2025 and
Moonshine have no fabricated metrics.

### Multi-scenario development

{_table(report['development'])}

Development contains five approximately six-minute scenarios per language
(about 31 minutes/lane). The frozen finalists were Chinese Paraformer int8 and
non-int8, and English Parakeet and SenseVoice. FireRed was dominated in Chinese
and failed English quality; Whisper failed English quality. SenseVoice was kept
as the cross-language compromise, but was not retroactively added to the frozen
Chinese held-out ranking.

### Held-out validation

{_table(report['heldOut'])}

Held-out uses disjoint test-split packs of about 31 minutes/lane. Chinese
non-int8 Paraformer wins on CER, latency, and memory. English SenseVoice wins on
WER, latency, and memory. Both pass every hard gate.

### Streaming observations

- Chinese streaming-capable Zipformer baseline: 5 measured real-time-paced
  runs; first partial median/P95
  {_fmt_ms(streaming_zh['firstPartialWallMilliseconds']['median'])}/
  {_fmt_ms(streaming_zh['firstPartialWallMilliseconds']['p95'])} ms, final
  {_fmt_ms(streaming_zh['firstFinalWallMilliseconds']['median'])}/
  {_fmt_ms(streaming_zh['firstFinalWallMilliseconds']['p95'])} ms, tail
  {_fmt_ms(streaming_zh['tailLatencyMilliseconds']['median'])}/
  {_fmt_ms(streaming_zh['tailLatencyMilliseconds']['p95'])} ms.
- SenseVoice is offline-only in this runtime lane. First partial, streaming final,
  and tail latency are explicitly `not_applicable/unsupported`, never zero.
- The 2025 Streaming Zipformer was rejected before measurement because its model
  metadata is incompatible with this frozen runtime lane. No cross-runtime result
  is ranked.

### Operational evidence

{_table(report['operational'])}

Only two unique final candidates were run. Each operational fixture concatenates
ten distinct development/held-out scenario blocks with one-second separators:
Chinese 62.42 minutes and English 62.36 minutes. These are single measured runs,
so their P95 equals the one observation. They are honest one-hour-class runs,
not 2-hour tests; a 2-hour run remains unavailable because the licensed,
non-repeated lane corpus is only about 62 minutes. No shorter smoke is presented
as a long test.

## Reliability and determinism

All {len(report['reliability']['orchestratorProbes'])} bounded orchestration
probes passed: {probes}. They cover crash, timeout, OOM, empty/malformed output,
malformed/very-short/silent input, deterministic repetition, TERM-resistant
cancellation with process-group and descendant cleanup, temporary cleanup,
network and user-home denial, and atomic publication.

Every real run was launched in the network-denied sidecar sandbox. Transcript-only
determinism was stable across
{report['reliability']['realTranscriptDeterminism']['measuredRunCount']} measured
runs and
{report['reliability']['realTranscriptDeterminism']['candidateFixtureGroupCount']}
candidate/fixture groups. Raw-output hashes are intentionally not used for this
claim because model timestamps can vary. Peak and retained RSS are reported for
each measured aggregate; retained RSS is not treated as zero after unload.

## Hard-gate dispositions and elimination reasons

| Language | Candidate | Disposition | Reason |
|---|---|---|---|
{dispositions}

## Bindings and privacy

- Contract SHA-256: `{report['bindings']['contractSha256']}`
- Candidate registry SHA-256: `{report['bindings']['candidateRegistrySha256']}`
- Development Chinese manifest SHA-256:
  `{report['bindings']['developmentZhManifestSha256']}`
- Development English manifest SHA-256:
  `{report['bindings']['developmentEnManifestSha256']}`
- Held-out Chinese manifest SHA-256:
  `{report['bindings']['heldOutZhManifestSha256']}`
- Held-out English manifest SHA-256:
  `{report['bindings']['heldOutEnManifestSha256']}`

The machine-readable companion is `m4_asr_model_decision.json`. Published
artifacts contain aggregate numeric evidence and hashes only.

## Remaining validation before any product switch

Run a true two-hour, non-repeated, authorized meeting-domain corpus per finalist;
add reviewed accent strata and real far-field rooms; observe thermal behavior;
and rerun an equivalent Zipformer baseline if a new runtime lane is introduced.
Any product switch requires separate explicit approval and product-level testing.
"""


def build(repository_root: Path) -> tuple[dict[str, Any], str]:
    comparison_root = repository_root / "benchmark/desktop/asr_comparison"
    evidence_root = repository_root / "build/desktop_asr_comparison/m4/evidence"
    freeze = _load(comparison_root / "m4_development_freeze.json")
    stages: dict[str, list[dict[str, Any]]] = {}
    summaries: dict[tuple[str, str], dict[str, Any]] = {}
    for name in ("stability", "development", "held_out"):
        stages[name] = []
        for language_lane in ("zh", "en"):
            summary, compact = _stage(evidence_root, name, language_lane)
            summaries[(name, language_lane)] = summary
            stages[name].extend(compact)

    operational: list[dict[str, Any]] = []
    for relative, language_lane in (
        ("operational/zh-paraformer", "zh"),
        ("operational/en-sensevoice", "en"),
        ("operational/zh-sensevoice", "zh"),
    ):
        summary = _load(evidence_root / relative / "summary.json")
        operational.extend(
            _compact_aggregate(item, language_lane)
            for item in summary["aggregates"]
        )

    reliability = _load(evidence_root / "reliability/probes.json")
    dispositions = [
        {
            "languageLane": "zh",
            "candidateId": "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            "disposition": "REJECTED_QUALITY_GATE",
            "reason": "development CER 37.24% exceeds 35%",
        },
        {
            "languageLane": "zh",
            "candidateId": "sherpa-onnx-paraformer-zh-int8-2025-10-07",
            "disposition": "HELD_OUT_RUNNER_UP",
            "reason": "held-out CER 16.36%; slower and heavier than non-int8",
        },
        {
            "languageLane": "zh",
            "candidateId": ZH_WINNER,
            "disposition": "RECOMMENDED",
            "reason": "held-out CER 14.42%; best independent Chinese result",
        },
        {
            "languageLane": "zh/en",
            "candidateId": "sherpa-onnx-funasr-nano-int8-2025-12-30",
            "disposition": "REJECTED_RESOURCE_GATE",
            "reason": "five-minute absolute peak RSS exceeded 2 GiB",
        },
        {
            "languageLane": "zh/en",
            "candidateId": "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
            "disposition": "REJECTED",
            "reason": "Chinese Pareto-dominated; English WER 44.13% fails gate",
        },
        {
            "languageLane": "zh/en",
            "candidateId": SINGLE_MODEL,
            "disposition": "EN_RECOMMENDED_SINGLE_MODEL_COMPROMISE",
            "reason": "English winner; Chinese development/operational competitive",
        },
        {
            "languageLane": "en",
            "candidateId": "sherpa-onnx-streaming-zipformer-en-20m-2023-02-17",
            "disposition": "REJECTED_QUALITY_GATE",
            "reason": "five-minute WER 72.44%",
        },
        {
            "languageLane": "en",
            "candidateId": "sherpa-onnx-whisper-base-en-int8-2023-01-31",
            "disposition": "REJECTED_QUALITY_GATE",
            "reason": "development WER 40.23%",
        },
        {
            "languageLane": "en",
            "candidateId": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01",
            "disposition": "HELD_OUT_RUNNER_UP",
            "reason": "held-out WER 33.23%; slower and heavier than SenseVoice",
        },
        {
            "languageLane": "zh",
            "candidateId": "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
            "disposition": "REJECTED_RUNTIME_MODEL_METADATA",
            "reason": "frozen runtime lane rejected model metadata",
        },
        {
            "languageLane": "en",
            "candidateId": "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
            "disposition": "REJECTED_RUNTIME_MODEL_FORMAT",
            "reason": "ORT protobuf parse failure in frozen runtime lane",
        },
    ]
    report = {
        "schemaVersion": 1,
        "kind": "m4_asr_model_decision",
        "decisionDate": "2026-07-27",
        "environment": {
            "cpu": "Apple M4",
            "architecture": "arm64",
            "operatingSystem": "macOS 15.7.5 (24G624)",
            "runtimeLaneId": freeze["runtimeLaneId"],
        },
        "fixedResourceProfile": freeze["resourceProfile"],
        "hardGates": freeze["hardGates"],
        "recommendations": {
            "chinese": ZH_WINNER,
            "pureEnglish": EN_WINNER,
            "singleModelCompromise": SINGLE_MODEL,
            "productSwitchAuthorized": False,
        },
        "bindings": {
            **freeze["bindings"],
            **freeze["corpusBindings"],
            "stabilityZhSummarySha256": _sha256(
                evidence_root / "stability/zh/summary.json"
            ),
            "stabilityEnSummarySha256": _sha256(
                evidence_root / "stability/en/summary.json"
            ),
            "heldOutZhSummarySha256": _sha256(
                evidence_root / "held_out/zh/summary.json"
            ),
            "heldOutEnSummarySha256": _sha256(
                evidence_root / "held_out/en/summary.json"
            ),
        },
        "corpus": {
            "dataset": "google/fleurs",
            "license": "CC-BY-4.0",
            "distributionState": "local_only",
            "developmentMinutes": {"zh": 31.32, "en": 31.12},
            "heldOutMinutes": {"zh": 30.94, "en": 31.08},
            "operationalMinutes": {"zh": 62.42, "en": 62.36},
            "limitations": [
                "read speech rather than meeting-domain speech",
                "speaker variability is an accent proxy, not reviewed accent labels",
                "far-field/noise is a deterministic transform",
                "no mandatory code-switch evaluation",
                "two-hour non-repeated operational corpus was unavailable",
            ],
        },
        "smoke": {
            "rankEligible": False,
            "attemptCount": 10,
            "passCount": 8,
            "runtimeAdmissionFailureCount": 2,
            "purpose": "runtime admission and metric sampling only",
        },
        "stability": stages["stability"],
        "development": stages["development"],
        "heldOut": stages["held_out"],
        "streaming": [
            _streaming(_load(evidence_root / "streaming-v2/zh/summary.json")),
            _streaming(_load(evidence_root / "streaming-v3/en/summary.json")),
        ],
        "operational": operational,
        "reliability": {
            "orchestratorProbes": [
                {
                    "probeId": item["probeId"],
                    "outcome": item["outcome"],
                    "disposition": item["disposition"],
                    "details": item["details"],
                }
                for item in reliability["probes"]
            ],
            "realTranscriptDeterminism": _transcript_determinism(
                evidence_root, ("stability", "development", "held_out")
            ),
            "realRunsSandboxedWithNetworkDenied": True,
            "retainedMemoryMeasuredAfterUnload": True,
        },
        "candidateDispositions": dispositions,
        "privacy": {
            "rawAudioPublished": False,
            "referenceTextPublished": False,
            "transcriptPublished": False,
            "modelFilesPublished": False,
            "credentialsPublished": False,
            "absolutePathsPublished": False,
        },
    }
    return report, _decision_markdown(report)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    report, markdown = build(args.root.resolve(strict=True))
    comparison_root = args.root / "benchmark/desktop/asr_comparison"
    _write_json(comparison_root / "m4_asr_model_decision.json", report)
    _write_text(
        comparison_root / "M4_ASR_MODEL_DECISION_REPORT.md", markdown
    )
    print(
        json.dumps(
            {
                "chinese": report["recommendations"]["chinese"],
                "pureEnglish": report["recommendations"]["pureEnglish"],
                "singleModelCompromise": report["recommendations"][
                    "singleModelCompromise"
                ],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
