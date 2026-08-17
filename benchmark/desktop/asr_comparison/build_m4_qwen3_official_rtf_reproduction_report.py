#!/usr/bin/env python3
"""Validate and publish the privacy-safe M4 Qwen3 official-RTF reproduction."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import re
import statistics
import tempfile
from pathlib import Path
from typing import Any, Callable

from run_macos_asr_comparison import canonical_json, sha256_bytes, sha256_file
from run_expanded_stage0 import _tokenizer_tree_hash


COMPARISON_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = COMPARISON_ROOT.parents[2]
REPORT_JSON = COMPARISON_ROOT / "m4_qwen3_official_rtf_reproduction.json"
REPORT_MARKDOWN = COMPARISON_ROOT / "M4_QWEN3_OFFICIAL_RTF_REPRODUCTION_REPORT.md"
EXPECTED_LANES = {
    "native-v1.12.34-ort1.23.2-page-era": 5,
    "native-v1.13.4-ort1.24.4-diagnostic": 3,
    "native-v1.13.4-ort1.27.0-current": 5,
    "dart-v1.13.4-ort1.27.0-fixed15-current-worker": 5,
    "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker": 5,
    "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker": 5,
}
OFFICIAL_REPRODUCTION_RELATIVE_TOLERANCE = 0.10
RUNTIME_REGRESSION_RATIO_THRESHOLD = 1.50
HEX_32 = re.compile(r"^[0-9a-f]{32}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_ABSOLUTE = re.compile(r"(?i)(?:^|[\s\"'`(])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])")
POSIX_ABSOLUTE = re.compile(
    r"(?:^|[\s\"'`(])/(?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+"
)
PUBLIC_URL = re.compile(r"https?://[^\s)>\]]+")
NATIVE_ELAPSED_RE = re.compile(r"Elapsed seconds:\s+([0-9.]+)\s+s")
NATIVE_RTF_RE = re.compile(
    r"Real time factor \(RTF\):\s+([0-9.]+)\s+/\s+([0-9.]+)\s+=\s+([0-9.]+)"
)
NATIVE_SEGMENT_RE = re.compile(r"^([0-9.]+)\s+--\s+([0-9.]+):")
SUMMARY_KEYS = {
    "warmupRunCount",
    "measuredRunCount",
    "warmupObservations",
    "observations",
    "metrics",
    "officialComparison",
}
OBSERVATION_KEYS = {
    "absolutePeakRssBytes",
    "cliReportedRtf",
    "completedAt",
    "decodeMilliseconds",
    "detectorSegmentCount",
    "emittedResultSegmentCount",
    "emittedResultSegmentDurationP50Seconds",
    "emittedResultSegmentDurationP95Seconds",
    "emittedResultSpeechDurationSeconds",
    "endToEndWallMilliseconds",
    "executionId",
    "ffiStringCopyMilliseconds",
    "incrementalPeakRssBytes",
    "jsonRepairAndDecodeMilliseconds",
    "laneId",
    "loadMilliseconds",
    "metricSupport",
    "nativeResultFetchMilliseconds",
    "officialComparableProcessingMilliseconds",
    "officialComparableRtf",
    "outputTokenCount",
    "processWallMilliseconds",
    "rawEvidence",
    "rawOutputSha256",
    "recognizerDecodeMilliseconds",
    "resumed",
    "resultConversionMilliseconds",
    "retainedRssBytesAfterUnload",
    "rtf",
    "runIndex",
    "samplerIntervalMilliseconds",
    "scheduleOrder",
    "segmentCount",
    "segmentDurationsSeconds",
    "segmentLatencyP50Milliseconds",
    "segmentLatencyP95Milliseconds",
    "startedAt",
    "threads",
    "timingSemantics",
    "tokensPerAudioSecond",
    "vadMilliseconds",
    "warmup",
}
FORBIDDEN_PAYLOAD_KEYS = {
    "hypothesis",
    "reference",
    "referencetext",
    "text",
    "tokens",
    "transcript",
    "transcripttext",
}
EXPECTED_METRIC_KEYS = {
    "absolutePeakRssBytes",
    "cliReportedRtf",
    "decodeMilliseconds",
    "detectorSegmentCount",
    "emittedResultSegmentCount",
    "emittedResultSpeechDurationSeconds",
    "endToEndWallMilliseconds",
    "ffiStringCopyMilliseconds",
    "incrementalPeakRssBytes",
    "jsonRepairAndDecodeMilliseconds",
    "loadMilliseconds",
    "nativeResultFetchMilliseconds",
    "officialComparableProcessingMilliseconds",
    "officialComparableRtf",
    "outputTokenCount",
    "processWallMilliseconds",
    "recognizerDecodeMilliseconds",
    "resultConversionMilliseconds",
    "retainedRssBytesAfterUnload",
    "rtf",
    "segmentLatencyP50Milliseconds",
    "segmentLatencyP95Milliseconds",
    "tokensPerAudioSecond",
    "vadMilliseconds",
}


class PublicationError(ValueError):
    pass


def _load(path: Path) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise PublicationError(f"non-finite JSON value is forbidden: {value}")

    value = json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=reject_constant,
    )
    if not isinstance(value, dict):
        raise PublicationError(f"{path.name} must contain an object")
    return value


def _median(summary: dict[str, Any], metric: str) -> float:
    value = summary["metrics"][metric]
    if value.get("support") != "measured":
        raise PublicationError(f"{metric} must be measured")
    result = float(value["median"])
    if not math.isfinite(result) or result < 0:
        raise PublicationError(f"{metric} median is invalid")
    return result


def _ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        raise PublicationError("ratio denominator must be positive")
    return numerator / denominator


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PublicationError(message)


def _verify_hash(path: Path, expected: str, label: str) -> None:
    _require(HEX_64.fullmatch(expected) is not None, f"{label} is not SHA-256")
    _require(path.is_file(), f"{label} local artifact is missing")
    _require(sha256_file(path) == expected, f"{label} local artifact hash mismatch")


def _nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def _bootstrap_median_ci(values: list[float], samples: int = 10_000) -> list[float]:
    generator = random.Random(20260727)
    medians = [
        statistics.median(generator.choices(values, k=len(values)))
        for _ in range(samples)
    ]
    medians.sort()
    return [
        medians[int(samples * 0.025)],
        medians[min(samples - 1, int(samples * 0.975))],
    ]


def _same_number(actual: Any, expected: float) -> bool:
    return (
        isinstance(actual, (int, float))
        and not isinstance(actual, bool)
        and math.isfinite(float(actual))
        and math.isclose(float(actual), expected, rel_tol=1e-12, abs_tol=1e-9)
    )


def _reject_sensitive_payload_keys(value: Any, context: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).replace("_", "").lower()
            _require(
                normalized not in FORBIDDEN_PAYLOAD_KEYS,
                f"{context} contains forbidden payload key {key}",
            )
            _reject_sensitive_payload_keys(item, context)
    elif isinstance(value, list):
        for item in value:
            _reject_sensitive_payload_keys(item, context)


def _validate_metric_states(summary: dict[str, Any], lane_id: str) -> None:
    _require(set(summary) == SUMMARY_KEYS, f"{lane_id} summary keys changed")
    observations = summary["observations"]
    metrics = summary.get("metrics", {})
    _require(
        set(metrics) == EXPECTED_METRIC_KEYS,
        f"{lane_id} metric set changed",
    )
    for name, metric in metrics.items():
        support = metric.get("support")
        _require(
            support in {"measured", "unsupported", "not_applicable"},
            f"{lane_id}.{name} has invalid support state",
        )
        values = [
            float(observation[name])
            for observation in observations
            if isinstance(observation.get(name), (int, float))
            and not isinstance(observation.get(name), bool)
        ]
        _require(
            all(math.isfinite(value) and value >= 0 for value in values),
            f"{lane_id}.{name} observation values are invalid",
        )
        if support == "measured":
            _require(
                set(metric)
                == {
                    "support",
                    "count",
                    "median",
                    "p95",
                    "minimum",
                    "maximum",
                    "median95PercentBootstrapCI",
                },
                f"{lane_id}.{name} measured keys changed",
            )
            _require(values, f"{lane_id}.{name} has no measured observations")
            _require(
                isinstance(metric["count"], int)
                and not isinstance(metric["count"], bool)
                and metric["count"] > 0,
                f"{lane_id}.{name} count type is invalid",
            )
            expected = {
                "count": len(values),
                "median": statistics.median(values),
                "p95": _nearest_rank(values, 0.95),
                "minimum": min(values),
                "maximum": max(values),
            }
            _require(
                metric["count"] == expected["count"],
                f"{lane_id}.{name} count mismatch",
            )
            for key in ("median", "p95", "minimum", "maximum"):
                _require(
                    _same_number(metric[key], float(expected[key])),
                    f"{lane_id}.{name} {key} mismatch",
                )
            _require(
                float(metric["minimum"])
                <= float(metric["median"])
                <= float(metric["p95"])
                <= float(metric["maximum"]),
                f"{lane_id}.{name} ordering is invalid",
            )
            interval = metric["median95PercentBootstrapCI"]
            expected_interval = _bootstrap_median_ci(values)
            _require(
                isinstance(interval, list)
                and len(interval) == 2
                and all(
                    _same_number(value, expected_value)
                    for value, expected_value in zip(
                        interval, expected_interval, strict=True
                    )
                ),
                f"{lane_id}.{name} bootstrap interval mismatch",
            )
        else:
            _require(
                set(metric) == {"support", "reasonCode"},
                f"{lane_id}.{name} unsupported keys changed",
            )
            _require(
                not values,
                f"{lane_id}.{name} has numeric values despite {support}",
            )
            _require(
                isinstance(metric.get("reasonCode"), str)
                and bool(metric["reasonCode"]),
                f"{lane_id}.{name} support reason is missing",
            )
    comparison = summary["officialComparison"]
    _require(
        set(comparison)
        == {
            "officialRtf",
            "medianRtfRatio",
            "medianRtfAbsoluteDifference",
        },
        f"{lane_id} official comparison keys changed",
    )
    median_rtf = float(metrics["rtf"]["median"])
    _require(comparison["officialRtf"] == 0.103, f"{lane_id} official RTF changed")
    _require(
        _same_number(comparison["medianRtfRatio"], median_rtf / 0.103)
        and _same_number(
            comparison["medianRtfAbsoluteDifference"],
            median_rtf - 0.103,
        ),
        f"{lane_id} official comparison mismatch",
    )


def _timestamp(value: Any, label: str) -> dt.datetime:
    _require(isinstance(value, str), f"{label} timestamp is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PublicationError(f"{label} timestamp is invalid") from error
    _require(parsed.tzinfo is not None, f"{label} timestamp lacks timezone")
    return parsed


def _relative_artifact(root: Path, value: Any, label: str) -> Path:
    _require(isinstance(value, str) and bool(value), f"{label} path is missing")
    relative = Path(value)
    _require(
        not relative.is_absolute()
        and ".." not in relative.parts
        and str(relative) == value,
        f"{label} path is unsafe",
    )
    resolved_root = root.resolve()
    resolved = (root / relative).resolve()
    _require(
        resolved == resolved_root or resolved_root in resolved.parents,
        f"{label} escapes evidence root",
    )
    return resolved


def _observation_evidence_root(local_root: Path, lane_id: str) -> Path:
    if lane_id.startswith("native-current-threads-"):
        return local_root / "evidence/thread-probes"
    if lane_id == "native-current-sampler-off":
        return local_root / "evidence/sampler-off-probe"
    return local_root / "evidence" / lane_id


def _validate_raw_evidence(
    observation: dict[str, Any],
    *,
    local_root: Path,
) -> None:
    lane_id = str(observation["laneId"])
    root = _observation_evidence_root(local_root, lane_id)
    evidence = observation.get("rawEvidence")
    _require(isinstance(evidence, dict), f"{lane_id} raw evidence is missing")
    if lane_id.startswith("native-"):
        _require(
            set(evidence)
            == {
                "kind",
                "stdoutRelativePath",
                "stdoutSha256",
                "stderrRelativePath",
                "stderrSha256",
                "observationRecordRelativePath",
                "observationRecordSha256",
            }
            and evidence.get("kind") == "native_cli_logs",
            f"{lane_id} native raw evidence keys changed",
        )
        stdout_path = _relative_artifact(
            root, evidence["stdoutRelativePath"], f"{lane_id} stdout"
        )
        stderr_path = _relative_artifact(
            root, evidence["stderrRelativePath"], f"{lane_id} stderr"
        )
        _verify_hash(stdout_path, evidence["stdoutSha256"], f"{lane_id} stdout")
        _verify_hash(stderr_path, evidence["stderrSha256"], f"{lane_id} stderr")
        observation_record_path = _relative_artifact(
            root,
            evidence["observationRecordRelativePath"],
            f"{lane_id} observation record",
        )
        _verify_hash(
            observation_record_path,
            evidence["observationRecordSha256"],
            f"{lane_id} observation record",
        )
        observation_record = _load(observation_record_path)
        _require(
            observation_record.get("schemaVersion") == 2
            and observation_record.get("kind")
            == "m4_qwen3_native_observation_binding"
            and observation_record.get("observation")
            == {
                key: value
                for key, value in observation.items()
                if key not in {"rawEvidence", "threads"}
            },
            f"{lane_id} native observation binding mismatch",
        )
        stdout = stdout_path.read_text(encoding="utf-8")
        stderr = stderr_path.read_text(encoding="utf-8")
        if "threads" in observation:
            threads = observation["threads"]
            _require(
                lane_id == f"native-current-threads-{threads}"
                and f"--num-threads={threads} " in stderr
                and f"num threads: {threads}" in stderr,
                f"{lane_id} thread probe disagrees with raw CLI config",
            )
        elapsed_match = NATIVE_ELAPSED_RE.search(stderr)
        rtf_match = NATIVE_RTF_RE.search(stderr)
        _require(
            elapsed_match is not None and rtf_match is not None,
            f"{lane_id} native raw timing is missing",
        )
        elapsed = float(elapsed_match.group(1))
        denominator = float(rtf_match.group(2))
        reported = float(rtf_match.group(3))
        _require(
            _same_number(observation["decodeMilliseconds"], elapsed * 1000)
            and _same_number(observation["cliReportedRtf"], reported)
            and _same_number(
                observation["officialComparableRtf"],
                elapsed / denominator,
            )
            and _same_number(observation["rtf"], elapsed / denominator),
            f"{lane_id} native observation disagrees with raw CLI output",
        )
        emitted_segments = [
            (float(match.group(1)), float(match.group(2)))
            for line in stdout.splitlines()
            if (match := NATIVE_SEGMENT_RE.match(line))
        ]
        durations = [end - start for start, end in emitted_segments]
        _require(
            observation.get("emittedResultSegmentCount") == len(emitted_segments)
            and _same_number(
                observation.get("emittedResultSpeechDurationSeconds"),
                sum(durations),
            ),
            f"{lane_id} emitted-result metrics disagree with stdout",
        )
        return

    _require(
        set(evidence)
        == {
            "kind",
            "runId",
            "runRecordRelativePath",
            "runRecordSha256",
            "rawRecordRelativePath",
            "rawRecordSha256",
        }
        and evidence.get("kind") == "dart_execute_run",
        f"{lane_id} Dart raw evidence keys changed",
    )
    run_path = _relative_artifact(
        root, evidence["runRecordRelativePath"], f"{lane_id} run record"
    )
    raw_path = _relative_artifact(
        root, evidence["rawRecordRelativePath"], f"{lane_id} raw record"
    )
    _verify_hash(run_path, evidence["runRecordSha256"], f"{lane_id} run record")
    _verify_hash(raw_path, evidence["rawRecordSha256"], f"{lane_id} raw record")
    run = _load(run_path)
    raw = _load(raw_path)
    run_id = evidence["runId"]
    _require(
        run.get("runId") == raw.get("runId") == run_id,
        f"{lane_id} run identity mismatch",
    )
    _require(
        run.get("complete") is True
        and run.get("disposition") == "SUCCESS"
        and run.get("resumed") is False,
        f"{lane_id} run record is not a fresh success",
    )
    for key in ("laneId", "runIndex", "warmup", "scheduleOrder"):
        _require(
            run.get(key) == observation.get(key),
            f"{lane_id} run record {key} mismatch",
        )
    for key, value in run.get("metrics", {}).items():
        if key in observation and isinstance(value, (int, float)):
            _require(
                _same_number(observation[key], float(value)),
                f"{lane_id} run metric {key} mismatch",
            )
    result = next(
        (event for event in raw.get("events", []) if event.get("type") == "result"),
        None,
    )
    _require(isinstance(result, dict), f"{lane_id} raw result is missing")
    semantic_hash = sha256_bytes(
        canonical_json(
            {
                "text": result.get("text"),
                "tokens": result.get("tokens"),
                "timestamps": result.get("timestamps"),
            }
        )
    )
    _require(
        semantic_hash
        == observation.get("rawOutputSha256")
        == run.get("rawOutputSha256"),
        f"{lane_id} raw semantic result hash mismatch",
    )
    decode = float(run["metrics"]["decodeMilliseconds"])
    vad = result.get("vadMilliseconds")
    official_processing = decode + (float(vad) if vad is not None else 0.0)
    duration = float(result["durationSeconds"])
    _require(
        _same_number(
            observation["recognizerDecodeMilliseconds"],
            decode,
        )
        and _same_number(
            observation["officialComparableProcessingMilliseconds"],
            official_processing,
        )
        and _same_number(
            observation["officialComparableRtf"],
            official_processing / (duration * 1000),
        )
        and observation["outputTokenCount"] == len(result["tokens"])
        and _same_number(
            observation["tokensPerAudioSecond"],
            len(result["tokens"]) / duration,
        )
        and observation["segmentCount"] == result["segmentCount"]
        and observation.get("segmentDurationsSeconds")
        == result.get("segmentDurationsSeconds"),
        f"{lane_id} derived observation fields disagree with raw result",
    )
    for field in (
        "vadMilliseconds",
        "nativeResultFetchMilliseconds",
        "ffiStringCopyMilliseconds",
        "jsonRepairAndDecodeMilliseconds",
        "resultConversionMilliseconds",
    ):
        raw_value = result.get(field)
        observed_value = observation.get(field)
        _require(
            (raw_value is None and observed_value is None)
            or _same_number(observed_value, float(raw_value)),
            f"{lane_id} raw extension {field} mismatch",
        )


def _validate_observation(
    observation: Any,
    *,
    lane_id: str,
    expected_warmup: bool,
    execution_start: dt.datetime,
    execution_end: dt.datetime,
    execution_ids: set[str],
    local_root: Path,
) -> None:
    _require(isinstance(observation, dict), f"{lane_id} observation is invalid")
    _require(
        set(observation).issubset(OBSERVATION_KEYS),
        f"{lane_id} observation contains unknown keys",
    )
    _reject_sensitive_payload_keys(observation, f"{lane_id} observation")
    for key, value in observation.items():
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if isinstance(candidate, (int, float)) and not isinstance(
                candidate, bool
            ):
                _require(
                    math.isfinite(float(candidate)) and float(candidate) >= 0,
                    f"{lane_id} observation {key} is invalid",
                )
    _require(observation.get("laneId") == lane_id, f"{lane_id} identity changed")
    _require(
        observation.get("warmup") is expected_warmup,
        f"{lane_id} warm-up identity changed",
    )
    _require(
        isinstance(observation.get("runIndex"), int)
        and not isinstance(observation.get("runIndex"), bool)
        and isinstance(observation.get("scheduleOrder"), int)
        and not isinstance(observation.get("scheduleOrder"), bool),
        f"{lane_id} run/schedule index type changed",
    )
    execution_id = str(observation.get("executionId"))
    _require(
        HEX_32.fullmatch(execution_id) is not None,
        f"{lane_id} observation executionId is invalid",
    )
    _require(
        execution_id not in execution_ids,
        f"{lane_id} observation executionId is duplicated",
    )
    execution_ids.add(execution_id)
    started = _timestamp(observation.get("startedAt"), f"{lane_id} observation start")
    completed = _timestamp(
        observation.get("completedAt"), f"{lane_id} observation completion"
    )
    _require(
        execution_start <= started <= completed <= execution_end,
        f"{lane_id} observation is outside execution time window",
    )
    _require(
        observation.get("resumed", False) is False,
        f"{lane_id} contains resumed evidence",
    )
    _validate_raw_evidence(observation, local_root=local_root)


def validate_bounded(
    bounded: dict[str, Any],
    *,
    repository_root: Path,
    bounded_path: Path,
    experiment: dict[str, Any],
) -> None:
    _reject_sensitive_payload_keys(bounded, "bounded evidence")
    _require(bounded.get("schemaVersion") == 2, "bounded schemaVersion must be 2")
    _require(
        bounded.get("kind")
        == "m4_qwen3_official_rtf_reproduction_local_bounded_evidence",
        "bounded kind mismatch",
    )
    _require(bounded.get("outcome") == "COMPLETED", "bounded outcome is incomplete")
    execution = bounded.get("execution")
    _require(isinstance(execution, dict), "bounded execution identity is missing")
    _require(
        HEX_32.fullmatch(str(execution.get("executionId"))) is not None,
        "bounded executionId is invalid",
    )
    _require(
        isinstance(execution.get("startedAt"), str)
        and isinstance(execution.get("completedAt"), str),
        "bounded execution timestamps are missing",
    )
    execution_start = _timestamp(execution["startedAt"], "execution start")
    execution_end = _timestamp(execution["completedAt"], "execution completion")
    _require(execution_start <= execution_end, "execution time window is invalid")
    _require(execution.get("freshRunRequired") is True, "fresh-run contract changed")
    _require(execution.get("resumedRunCount") == 0, "resumed evidence is forbidden")
    _require(
        bounded.get("host", {}).get("cpu") == "Apple M4",
        "bounded evidence was not collected on the required Apple M4",
    )
    baseline = bounded.get("officialBaseline", {})
    _require(
        baseline.get("rtf") == 0.103
        and baseline.get("elapsedSeconds") == 34.480
        and baseline.get("audioDurationSeconds") == 334.234,
        "official baseline was substituted",
    )
    _require(
        bounded.get("strictControls")
        == {
            "provider": "cpu",
            "numThreads": 2,
            "modelPrecision": "int8",
            "maxTotalLen": 512,
            "maxNewTokens": 512,
            "temperature": 0.000001,
            "topP": 0.8,
            "seed": 42,
            "hotwords": "",
            "sileroVad": {
                "threshold": 0.2,
                "minimumSilenceSeconds": 0.5,
                "minimumSpeechSeconds": 0.2,
                "maximumSpeechSeconds": 20,
                "windowSize": 512,
                "provider": "cpu",
                "numThreads": 1,
            },
        },
        "strict official controls were substituted",
    )
    _require(
        set(bounded.get("lanes", {})) == set(EXPECTED_LANES),
        "bounded lane set is incomplete or substituted",
    )
    local_root = bounded_path.parent
    execution_ids: set[str] = set()
    for lane_id, measured_count in EXPECTED_LANES.items():
        summary = bounded["lanes"][lane_id]
        _require(summary.get("warmupRunCount") == 1, f"{lane_id} warm-up count mismatch")
        _require(
            summary.get("measuredRunCount") == measured_count,
            f"{lane_id} measured count mismatch",
        )
        warmups = summary.get("warmupObservations")
        observations = summary.get("observations")
        _require(
            isinstance(warmups, list) and len(warmups) == 1,
            f"{lane_id} warm-up observation is incomplete",
        )
        _require(
            isinstance(observations, list) and len(observations) == measured_count,
            f"{lane_id} measured observations are incomplete",
        )
        _validate_observation(
            warmups[0],
            lane_id=lane_id,
            expected_warmup=True,
            execution_start=execution_start,
            execution_end=execution_end,
            execution_ids=execution_ids,
            local_root=local_root,
        )
        for observation in observations:
            _validate_observation(
                observation,
                lane_id=lane_id,
                expected_warmup=False,
                execution_start=execution_start,
                execution_end=execution_end,
                execution_ids=execution_ids,
                local_root=local_root,
            )
        _validate_metric_states(summary, lane_id)

    fixed_lane = "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker"
    vad_lane = "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker"
    expected_measured_order = [
        lane_id
        for _ in range(5)
        for lane_id in (fixed_lane, vad_lane)
    ]
    schedule = bounded.get("diagnosticSegmentationSchedule")
    _require(
        schedule
        == {
            "design": "alternating_after_equal_lane_warmups",
            "warmupOrder": [fixed_lane, vad_lane],
            "measuredOrder": expected_measured_order,
            "scheduleOrderStart": 0,
        },
        "diagnostic segmentation schedule is not the required interleaving",
    )
    _require(
        bounded["lanes"][fixed_lane]["warmupObservations"][0]["scheduleOrder"] == 0
        and bounded["lanes"][vad_lane]["warmupObservations"][0]["scheduleOrder"] == 1,
        "diagnostic warm-up order mismatch",
    )
    actual_measured_order = [
        observation["laneId"]
        for observation in sorted(
            [
                *bounded["lanes"][fixed_lane]["observations"],
                *bounded["lanes"][vad_lane]["observations"],
            ],
            key=lambda item: item["scheduleOrder"],
        )
    ]
    _require(
        actual_measured_order == expected_measured_order
        and sorted(
            observation["scheduleOrder"]
            for lane_id in (fixed_lane, vad_lane)
            for observation in bounded["lanes"][lane_id]["observations"]
        )
        == list(range(2, 12)),
        "diagnostic measured order does not match interleaved schedule",
    )

    probes = bounded.get("diagnosticProbes")
    _require(
        isinstance(probes, dict)
        and set(probes)
        == {"threadScalingCurrentOrt127", "samplerOffCurrentOrt127"},
        "diagnostic probe set changed",
    )
    thread_observations = probes["threadScalingCurrentOrt127"]
    _require(
        isinstance(thread_observations, list)
        and [item.get("threads") for item in thread_observations] == [4, 6, 8],
        "thread probe observations are incomplete",
    )
    for observation in thread_observations:
        _validate_observation(
            observation,
            lane_id=f"native-current-threads-{observation['threads']}",
            expected_warmup=False,
            execution_start=execution_start,
            execution_end=execution_end,
            execution_ids=execution_ids,
            local_root=local_root,
        )
    sampler_summary = probes["samplerOffCurrentOrt127"]
    _require(
        sampler_summary.get("warmupRunCount") == 1
        and sampler_summary.get("measuredRunCount") == 2,
        "sampler-off probe run counts changed",
    )
    for observation in sampler_summary["warmupObservations"]:
        _validate_observation(
            observation,
            lane_id="native-current-sampler-off",
            expected_warmup=True,
            execution_start=execution_start,
            execution_end=execution_end,
            execution_ids=execution_ids,
            local_root=local_root,
        )
    for observation in sampler_summary["observations"]:
        _validate_observation(
            observation,
            lane_id="native-current-sampler-off",
            expected_warmup=False,
            execution_start=execution_start,
            execution_end=execution_end,
            execution_ids=execution_ids,
            local_root=local_root,
        )
    _validate_metric_states(sampler_summary, "native-current-sampler-off")

    _require(
        sha256_file(repository_root / "benchmark/desktop/asr_comparison/run_qwen3_official_rtf_reproduction.py")
        == bounded.get("runnerSha256"),
        "runner hash does not match executed bounded evidence",
    )
    provenance = bounded.get("provenance")
    _require(isinstance(provenance, dict), "bounded provenance is missing")
    runtime_roots = {
        "native-v1.12.34-ort1.23.2-page-era": (
            "runtime-1.12.34-ad-hoc",
            "runtime-1.12.34-original",
            "libonnxruntime.1.23.2.dylib",
        ),
        "native-v1.13.4-ort1.24.4-diagnostic": (
            "runtime-1.13.4-ort1.24.4-ad-hoc",
            "runtime-1.13.4-ort1.24.4-original",
            "libonnxruntime.1.24.4.dylib",
        ),
        "native-v1.13.4-ort1.27.0-current": (
            "runtime-ad-hoc",
            "runtime",
            "libonnxruntime.1.27.0.dylib",
        ),
    }
    native = provenance.get("nativeRuntimes", {})
    _require(set(native) == set(runtime_roots), "native runtime provenance mismatch")
    for lane_id, (executed_name, original_name, ort_name) in runtime_roots.items():
        item = native[lane_id]
        archive_name = item.get("archiveFileName")
        _require(
            isinstance(archive_name, str) and Path(archive_name).name == archive_name,
            f"{lane_id} archive name is unsafe",
        )
        _verify_hash(
            local_root / "download" / archive_name,
            item["archiveSha256"],
            f"{lane_id} archive",
        )
        for disposition, root_name, key in (
            ("executedAdHocSignedArtifactHashes", executed_name, "executed"),
            ("originalArtifactHashes", original_name, "original"),
        ):
            hashes = item[disposition]
            artifact_root = local_root / root_name
            _verify_hash(
                artifact_root / "bin/sherpa-onnx-vad-with-offline-asr",
                hashes["cliSha256"],
                f"{lane_id} {key} CLI",
            )
            _verify_hash(
                artifact_root / "lib/libsherpa-onnx-c-api.dylib",
                hashes["sherpaCApiSha256"],
                f"{lane_id} {key} sherpa dylib",
            )
            _verify_hash(
                artifact_root / "lib" / ort_name,
                hashes["onnxRuntimeSha256"],
                f"{lane_id} {key} ORT dylib",
            )

    dart = provenance["dart"]
    current_runtime = repository_root / "build/desktop_asr_comparison/m4/runtime"
    current_tools = repository_root / "build/desktop_asr_comparison/m4/tools-qwen3"
    diagnostic_tools = local_root / "tools"
    _verify_hash(
        current_runtime / "libsherpa-onnx-c-api.dylib",
        dart["runtime"]["sherpaCApiSha256"],
        "Dart executed sherpa dylib",
    )
    _verify_hash(
        current_runtime / "libonnxruntime.1.27.0.dylib",
        dart["runtime"]["onnxRuntimeSha256"],
        "Dart executed ORT dylib",
    )
    for group, tool_root, worker_name in (
        ("currentWorker", current_tools, "desktop_asr_candidate_worker"),
        (
            "diagnosticWorker",
            diagnostic_tools,
            "qwen3_official_rtf_diagnostic_worker",
        ),
    ):
        _verify_hash(
            tool_root / worker_name,
            dart[group]["workerSha256"],
            f"{group} binary",
        )
        _verify_hash(
            tool_root / "sandboxed_candidate_launcher",
            dart[group]["sandboxedLauncherSha256"],
            f"{group} sandbox launcher",
        )
        _verify_hash(
            tool_root / "native_process_group_launcher",
            dart[group]["nativeProcessGroupLauncherSha256"],
            f"{group} process-group launcher",
        )
    _verify_hash(
        repository_root
        / "packages/desktop_sherpa_worker/tool/qwen3_official_rtf_diagnostic_worker.dart",
        dart["diagnosticWorker"]["workerSourceSha256"],
        "diagnostic worker source",
    )

    model_root = (
        repository_root
        / "build/desktop_asr_comparison/m4/qwen3/extracted/"
        "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
    )
    for role, binding in experiment["candidate"]["artifacts"].items():
        path = model_root / binding["relativePath"]
        actual = _tokenizer_tree_hash(path) if role == "tokenizer" else sha256_file(path)
        _require(
            actual == provenance["modelHashes"][role] == binding["sha256"],
            f"model hash mismatch: {role}",
        )
    _verify_hash(
        local_root / "download/Obama.wav",
        provenance["audioSha256"],
        "official audio",
    )
    _verify_hash(
        local_root / "download/silero_vad.onnx",
        provenance["sileroVadSha256"],
        "Silero VAD",
    )
    _verify_hash(
        repository_root / "benchmark/desktop/asr_comparison/resource_sampler.py",
        provenance["resourceSamplerSha256"],
        "resource sampler",
    )


def _privacy_strings(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [
            text
            for key, item in value.items()
            for text in [*_privacy_strings(key), *_privacy_strings(item)]
        ]
    if isinstance(value, list):
        return [text for item in value for text in _privacy_strings(item)]
    return [value] if isinstance(value, str) else []


def _reject_absolute_paths(text: str) -> None:
    scrubbed = PUBLIC_URL.sub("", text)
    if WINDOWS_ABSOLUTE.search(scrubbed) or POSIX_ABSOLUTE.search(scrubbed):
        raise PublicationError("publishable output contains a local absolute path")


def _privacy_validate(document: dict[str, Any], markdown: str) -> None:
    _reject_sensitive_payload_keys(document, "publishable report")
    for text in [*_privacy_strings(document), markdown]:
        _reject_absolute_paths(text)
    encoded = json.dumps(document, sort_keys=True, allow_nan=False)
    for marker in ('"transcriptText":', '"referenceText":'):
        if marker in encoded or marker in markdown:
            raise PublicationError(f"privacy marker present: {marker}")
    _require(
        document["privacy"]
        == {
            "audioPublished": False,
            "modelFilesPublished": False,
            "transcriptPublished": False,
            "referenceTextPublished": False,
            "absolutePathsPublished": False,
            "rawLogsLocalOnly": True,
        },
        "privacy declaration changed",
    )


def build_report(
    bounded: dict[str, Any],
    experiment: dict[str, Any],
    freeze: dict[str, Any],
    *,
    bounded_summary_sha256: str | None = None,
    builder_sha256: str | None = None,
) -> dict[str, Any]:
    evidence_hash = bounded_summary_sha256 or sha256_bytes(canonical_json(bounded))
    builder_hash = builder_sha256 or sha256_file(Path(__file__))
    publication_id = sha256_bytes(f"{evidence_hash}:{builder_hash}".encode())[:24]
    lanes = bounded["lanes"]
    native_page = lanes["native-v1.12.34-ort1.23.2-page-era"]
    native_124 = lanes["native-v1.13.4-ort1.24.4-diagnostic"]
    native_127 = lanes["native-v1.13.4-ort1.27.0-current"]
    current_fixed = lanes["dart-v1.13.4-ort1.27.0-fixed15-current-worker"]
    diagnostic_fixed = lanes[
        "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker"
    ]
    diagnostic_vad = lanes[
        "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker"
    ]
    official_rtf = float(bounded["officialBaseline"]["rtf"])
    native_rtfs = {
        lane_id: _median(lanes[lane_id], "officialComparableRtf")
        for lane_id in (
            "native-v1.12.34-ort1.23.2-page-era",
            "native-v1.13.4-ort1.24.4-diagnostic",
            "native-v1.13.4-ort1.27.0-current",
        )
    }
    best_lane = min(native_rtfs, key=native_rtfs.get)
    best_local = native_rtfs[best_lane]
    reproduced = abs(best_local / official_rtf - 1) <= OFFICIAL_REPRODUCTION_RELATIVE_TOLERANCE
    runtime_ratio = _ratio(
        _median(native_127, "officialComparableRtf"),
        _median(native_124, "officialComparableRtf"),
    )
    runtime_regression = runtime_ratio >= RUNTIME_REGRESSION_RATIO_THRESHOLD
    fixed_by_run = {
        int(observation["runIndex"]): float(
            observation["officialComparableRtf"]
        )
        for observation in diagnostic_fixed["observations"]
    }
    vad_by_run = {
        int(observation["runIndex"]): float(
            observation["officialComparableRtf"]
        )
        for observation in diagnostic_vad["observations"]
    }
    _require(
        set(fixed_by_run) == set(vad_by_run) == set(range(1, 6)),
        "diagnostic paired run indices are incomplete",
    )
    segmentation_pair_ratios = [
        _ratio(vad_by_run[index], fixed_by_run[index])
        for index in range(1, 6)
    ]
    segmentation_ratio = statistics.median(segmentation_pair_ratios)
    sampler_ratio = _ratio(
        _median(
            bounded["diagnosticProbes"]["samplerOffCurrentOrt127"],
            "officialComparableRtf",
        ),
        _median(native_127, "officialComparableRtf"),
    )
    conversion_share = _ratio(
        _median(diagnostic_vad, "resultConversionMilliseconds"),
        _median(diagnostic_vad, "decodeMilliseconds"),
    )
    report = {
        "schemaVersion": 2,
        "kind": "m4_qwen3_official_rtf_reproduction",
        "outcome": "COMPLETED_NO_PRODUCT_CHANGE",
        "publicationId": publication_id,
        "boundedSummarySha256": evidence_hash,
        "builderSha256": builder_hash,
        "runnerSha256": bounded["runnerSha256"],
        "execution": bounded["execution"],
        "host": bounded["host"],
        "officialBaseline": bounded["officialBaseline"],
        "strictControls": bounded["strictControls"],
        "thresholds": {
            "officialReproductionRelativeTolerance": OFFICIAL_REPRODUCTION_RELATIVE_TOLERANCE,
            "runtimeRegressionRtfRatio": RUNTIME_REGRESSION_RATIO_THRESHOLD,
        },
        "assets": {
            "audio": bounded["audio"],
            "modelHashes": bounded["provenance"]["modelHashes"],
            "sileroVadSha256": bounded["provenance"]["sileroVadSha256"],
        },
        "provenance": bounded["provenance"],
        "timingBoundaries": {
            "nativeDecodeMilliseconds": (
                "official CLI elapsed; includes VAD, decoding, and file processing "
                "after model load and cannot be split into pure recognizer decode"
            ),
            "dartDecodeMilliseconds": (
                "worker decode phase; includes stream setup, waveform acceptance, "
                "decode, result conversion, and stream free; excludes segmentation/VAD"
            ),
            "endToEndWallMilliseconds": "input write/release through first result",
            "processWallMilliseconds": "process spawn through complete/exit",
            "officialComparableDartVad": "vadMilliseconds + decodeMilliseconds",
        },
        "lanes": {
            "A_nativeOfficialSilero": [
                "native-v1.12.34-ort1.23.2-page-era",
                "native-v1.13.4-ort1.24.4-diagnostic",
                "native-v1.13.4-ort1.27.0-current",
            ],
            "B_wholeAudio": {
                "support": "not_applicable",
                "reasonCode": "max_total_len_512_long_input_context_not_safe",
            },
            "C_currentWorkerFixed15": (
                "dart-v1.13.4-ort1.27.0-fixed15-current-worker"
            ),
            "segmentationControlledAB": {
                "controlled": True,
                "schedule": bounded["diagnosticSegmentationSchedule"],
                "fixed15": "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker",
                "officialSilero": (
                    "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker"
                ),
            },
            "formalAndIsolationResults": lanes,
            "diagnosticProbes": bounded["diagnosticProbes"],
        },
        "comparisons": {
            "bestLocalNativeLane": best_lane,
            "bestLocalNativeRtf": best_local,
            "bestLocalVsOfficialRtfRatio": _ratio(best_local, official_rtf),
            "ort127VsOrt124SameSherpaRtfRatio": runtime_ratio,
            "diagnosticVadVsDiagnosticFixed15ProcessingRtfRatio": segmentation_ratio,
            "diagnosticVadVsDiagnosticFixed15PairedRtfRatios": (
                segmentation_pair_ratios
            ),
            "diagnosticVadVsDiagnosticFixed15PairedRtfRatioP95": max(
                segmentation_pair_ratios
            ),
            "diagnosticSegmentationComparisonMethod": (
                "median_of_five_interleaved_same_run_index_pair_ratios"
            ),
            "samplerOffVsSampledNativeRtfRatioDescriptive": sampler_ratio,
            "diagnosticResultConversionShareOfDecode": conversion_share,
            "currentWorkerVsDiagnosticFixed15RtfRatio": _ratio(
                _median(current_fixed, "officialComparableRtf"),
                _median(diagnostic_fixed, "officialComparableRtf"),
            ),
        },
        "assessment": {
            "sameMachineReproducedOfficialWithinTolerance": reproduced,
            "runtimeRegressionThresholdMet": runtime_regression,
            "implementationRegressionAgainstOfficialProven": False,
            "samplerExactCausalOverhead": {
                "support": "unsupported",
                "reasonCode": "non_interleaved_small_sample_probe",
                "inference": "descriptive probe rules out sampler as an approximately_2x cause",
            },
            "officialHardwareAndCompleteBuild": "not_disclosed",
            "pageEraProxyCaveat": (
                "v1.12.34 introduced Qwen3-ASR but the page does not bind its "
                "numbers to that binary"
            ),
            "rootCauseRanking": [
                {
                    "rank": 1,
                    "cause": "runtime_ort_build_lane",
                    "supported": runtime_regression,
                    "rtfRatio": runtime_ratio,
                    "threshold": RUNTIME_REGRESSION_RATIO_THRESHOLD,
                },
                {
                    "rank": 2,
                    "cause": "unknown_official_hardware_and_build",
                    "supported": not reproduced,
                    "bestLocalVsOfficialRatio": _ratio(best_local, official_rtf),
                },
                {
                    "rank": 3,
                    "cause": "segmentation",
                    "diagnosticSameWorkerRtfRatio": segmentation_ratio,
                },
                {
                    "rank": 4,
                    "cause": "ffi_json_result_conversion",
                    "shareOfDecode": conversion_share,
                },
            ],
        },
        "priorTimingInterpretation": {
            "status": "validated",
            "statement": (
                "The prior 84–88 second measurements are decode times for "
                "approximately six-minute fixtures, not 15-second audio."
            ),
            "previousMedianDecodeMilliseconds": {"zh": 84517.612, "en": 88260.175},
            "previousMedianRtf": {
                "zh": freeze["developmentResults"]["zh"]["medianRtf"],
                "en": freeze["developmentResults"]["en"]["medianRtf"],
            },
            "comparisonMetric": "RTF",
        },
        "limitations": [
            "Official hardware and complete build flags are unknown.",
            "The page-era runtime is a proxy, not a page-bound official binary.",
            "Sampler runs are non-interleaved and too few for causal overhead.",
            "Native pure recognizer decode, detector census, detector latency, token count, conversion timing, and retained post-exit RSS are unavailable.",
            "GPU/vLLM concurrency throughput is excluded from single-stream M4 CPU comparison.",
        ],
        "recommendations": [
            "Bisect ORT 1.24.4 to 1.27.0 with identical sherpa source and compiler flags.",
            "Validate an ORT 1.24.x diagnostic pin with accuracy, stability, and memory checks before product consideration.",
            "Keep fixed segmentation and Silero VAD comparisons on the same diagnostic worker.",
            "Treat 4/6/8-thread and sampler probes as diagnostic lanes only.",
        ],
        "productImpact": {
            "defaultModelChanged": False,
            "productWorkerChanged": False,
            "diarizationChanged": False,
            "uiChanged": False,
            "frozenRankingChanged": False,
        },
        "privacy": {
            "audioPublished": False,
            "modelFilesPublished": False,
            "transcriptPublished": False,
            "referenceTextPublished": False,
            "absolutePathsPublished": False,
            "rawLogsLocalOnly": True,
        },
    }
    return report


def _metric(summary: dict[str, Any], name: str, *, scale: float = 1) -> str:
    metric = summary["metrics"][name]
    if metric["support"] != "measured":
        return f"{metric['support']} ({metric['reasonCode']})"
    return f"{metric['median'] / scale:.4f} / {metric['p95'] / scale:.4f}"


def build_markdown(report: dict[str, Any]) -> str:
    lanes = report["lanes"]["formalAndIsolationResults"]
    comparison = report["comparisons"]
    assessment = report["assessment"]
    reproduced = assessment["sameMachineReproducedOfficialWithinTolerance"]
    decision = "reproduced within tolerance" if reproduced else "not reproduced within tolerance"
    rows = []
    phase_rows = []
    memory_rows = []
    for lane_id in EXPECTED_LANES:
        summary = lanes[lane_id]
        rows.append(
            "| `{}` | {}+{} | {} | {} | {} | {} | {} |".format(
                lane_id,
                summary["warmupRunCount"],
                summary["measuredRunCount"],
                _metric(summary, "officialComparableRtf"),
                _metric(summary, "decodeMilliseconds"),
                _metric(summary, "endToEndWallMilliseconds"),
                _metric(summary, "processWallMilliseconds"),
                _metric(summary, "absolutePeakRssBytes", scale=1073741824),
            )
        )
        phase_rows.append(
            "| `{}` | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                lane_id,
                _metric(summary, "loadMilliseconds"),
                _metric(summary, "recognizerDecodeMilliseconds"),
                _metric(summary, "segmentLatencyP50Milliseconds"),
                _metric(summary, "segmentLatencyP95Milliseconds"),
                _metric(summary, "vadMilliseconds"),
                _metric(summary, "outputTokenCount"),
                _metric(summary, "tokensPerAudioSecond"),
                _metric(summary, "resultConversionMilliseconds"),
            )
        )
        memory_rows.append(
            "| `{}` | {} | {} | {} |".format(
                lane_id,
                _metric(summary, "absolutePeakRssBytes", scale=1073741824),
                _metric(summary, "incrementalPeakRssBytes", scale=1073741824),
                _metric(summary, "retainedRssBytesAfterUnload", scale=1073741824),
            )
        )
    native_runtime_rows = []
    for lane_id, provenance in report["provenance"]["nativeRuntimes"].items():
        executed = provenance["executedAdHocSignedArtifactHashes"]
        original = provenance["originalArtifactHashes"]
        build_flags = provenance["nativeBuildFlags"]
        native_runtime_rows.append(
            "| `{}` | {} / `{}` | {} | `{}` | `{}` / `{}` / `{}` | "
            "`{}` / `{}` / `{}` | {} ({}) |".format(
                lane_id,
                provenance["sherpaOnnxVersion"],
                provenance["sherpaOnnxGitSha1"],
                provenance["onnxRuntimeVersion"],
                provenance["archiveSha256"],
                executed["cliSha256"],
                executed["sherpaCApiSha256"],
                executed["onnxRuntimeSha256"],
                original["cliSha256"],
                original["sherpaCApiSha256"],
                original["onnxRuntimeSha256"],
                build_flags["support"],
                build_flags["reasonCode"],
            )
        )
    thread_rows = [
        "| {} | {:.4f} | {:.3f} | {:.4f} |".format(
            probe["threads"],
            probe["officialComparableRtf"],
            probe["decodeMilliseconds"],
            probe["absolutePeakRssBytes"] / 1073741824,
        )
        for probe in report["lanes"]["diagnosticProbes"][
            "threadScalingCurrentOrt127"
        ]
    ]
    dart_provenance = report["provenance"]["dart"]
    model_hash_lines = "\n".join(
        f"- `{role}`: `{sha256}`"
        for role, sha256 in sorted(report["assets"]["modelHashes"].items())
    )
    best_ratio = comparison["bestLocalVsOfficialRtfRatio"]
    runtime_ratio = comparison["ort127VsOrt124SameSherpaRtfRatio"]
    segmentation_ratio = comparison[
        "diagnosticVadVsDiagnosticFixed15ProcessingRtfRatio"
    ]
    sampler_ratio = comparison["samplerOffVsSampledNativeRtfRatioDescriptive"]
    conversion_share = comparison["diagnosticResultConversionShareOfDecode"]
    official = report["officialBaseline"]
    return f"""# Apple M4 Qwen3-ASR Official RTF Reproduction and Attribution

Publication ID: `{report["publicationId"]}`  
Bounded evidence SHA-256: `{report["boundedSummarySha256"]}`  
Builder SHA-256: `{report["builderSha256"]}`  
Runner SHA-256: `{report["runnerSha256"]}`

## Decision

The official RTF point is **{decision}** under the explicit ±{report["thresholds"]["officialReproductionRelativeTolerance"] * 100:.0f}% rule. The best local native lane was `{comparison["bestLocalNativeLane"]}` at median RTF **{comparison["bestLocalNativeRtf"]:.4f}**, **{best_ratio:.3f}×** the official {official["rtf"]:.3f}. Official hardware and complete build flags remain unknown, so this does not prove a regression against the official implementation.

On the same M4 and sherpa-onnx 1.13.4 source lane, ORT 1.27.0 / ORT 1.24.4 is **{runtime_ratio:.3f}×** by median official-comparable RTF. The predeclared regression threshold is {report["thresholds"]["runtimeRegressionRtfRatio"]:.2f}×; threshold met: **{str(assessment["runtimeRegressionThresholdMet"]).lower()}**.

No product model, product worker, diarization path, UI, or frozen ranking changed.

## Official control

The [official sherpa-onnx Qwen3-ASR page]({official["pageUrl"]}) reports Obama.wav as {official["audioDurationSeconds"]:.3f} seconds, {official["elapsedSeconds"]:.3f} seconds elapsed, and RTF {official["rtf"]:.3f}. The [public audio asset]({official["audioUrl"]}) and model/VAD assets remained local-only and are hash-bound in the JSON. All strict lanes use CPU, 2 threads, int8, max total/new tokens 512, temperature 1e-6, top-p 0.8, seed 42, empty hotwords, and Silero threshold 0.2/min speech 0.2 s/max speech 20 s.

The v1.12.34 lane is only a page-era proxy: it introduced Qwen3-ASR, but the page does not bind its number to that binary. The unmodified official archives are retained by hash; executed copies were locally ad-hoc signed after macOS provenance/signature enforcement. The JSON separately binds the archive, original CLI/dylibs, and exact executed CLI/dylibs.

## Same-machine results

Values are median / P95. Native `decodeMilliseconds` is the official CLI elapsed value and indivisibly includes VAD, decoding, and file processing after load. Dart `decodeMilliseconds` is the worker decode phase (stream setup, accept, decode, result conversion, free) and excludes segmentation/VAD. `endToEndWallMilliseconds` is input-to-first-result; `processWallMilliseconds` is spawn-to-complete/exit. Official-comparable Dart VAD processing is VAD + decode.

| Lane | Warm+measured | Official-comparable RTF | Decode ms | Input→result ms | Process wall ms | Peak RSS GiB |
|---|---:|---:|---:|---:|---:|---:|
{chr(10).join(rows)}

Whole-audio Dart input is `not_applicable` (`max_total_len_512_long_input_context_not_safe`).

### Phase, segment, and output metrics

Values are median / P95. “Worker decode phase” is not a kernel-only recognizer timer: for Dart it includes stream setup, waveform acceptance, decode, result conversion, and stream free; for native it is unsupported because the official CLI elapsed interval is indivisible. Segment P50/P95 is per-segment processing wall time, not audio duration.

| Lane | Load ms | Worker decode phase ms | Segment P50 ms | Segment P95 ms | VAD ms | Output tokens | Tokens/audio s | Result conversion ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
{chr(10).join(phase_rows)}

### Memory metrics

Values are median / P95 GiB. Native retained RSS is `not_applicable` after process exit; unsupported metrics are never represented as zero.

| Lane | Absolute peak | Incremental peak | Retained after unload |
|---|---:|---:|---:|
{chr(10).join(memory_rows)}

## Attribution

The segmentation comparison uses the same diagnostic worker on both sides and the median of five interleaved same-index pair ratios: official Silero / fixed-15 official-comparable processing RTF is **{segmentation_ratio:.4f}×**. The five pair ratios and P95 are published in JSON. The current-worker fixed lane is retained as a separate implementation control and is never used to claim segmentation cost.

Diagnostic result conversion is **{conversion_share * 100:.6f}%** of diagnostic VAD decode. Native CLI pure recognizer decode, detector segment census/latency, token count, and conversion timers are unsupported—not zero. Native stdout timestamps are reported only as emitted-result segment metrics, not as detector census.

The 20 ms sampler-off / sampled ratio is **{sampler_ratio:.4f}×**, but the small, non-interleaved probe cannot identify exact causal overhead. It is only sufficient to rule out RSS sampling as an approximately 2× explanation. Thread probes are diagnostic and not mixed into the two-thread comparison.

## Prior 84–88 second result

The earlier 84–88 second values were decode times for approximately six-minute fixtures, not 15-second audio. RTF, not whole-fixture wall time, is the official speed comparison.

## Root-cause order and actions

1. ORT/runtime build lane: the same-source ratio is {runtime_ratio:.3f}×.
2. Unknown official hardware/build: the residual official comparison is not hardware-attributable.
3. Segmentation: same-worker controlled ratio {segmentation_ratio:.4f}×.
4. FFI/JSON: measured conversion share {conversion_share * 100:.6f}%.

Bisect ORT 1.24.4→1.27.0 under identical compiler flags; validate any older-ORT diagnostic pin for accuracy, stability, and memory before product consideration; keep segmentation and thread experiments outside frozen ranking.

## Diagnostic thread probe

These single observations are non-ranked and have no per-thread confidence interval.

| Threads | RTF | CLI elapsed ms | Absolute peak RSS GiB |
|---:|---:|---:|---:|
{chr(10).join(thread_rows)}

## Runtime, build, and hash closure

The original archives and original extracted files were retained byte-for-byte. Separate ad-hoc-signed copies were executed after macOS provenance/signature enforcement terminated the downloaded binaries. `executed` hashes identify what ran; `original` hashes preserve upstream identity. Complete prebuilt compiler flags are unavailable and explicitly marked unsupported.

| Lane | sherpa version / git | ORT | Archive SHA-256 | Executed CLI / sherpa C API / ORT SHA-256 | Original CLI / sherpa C API / ORT SHA-256 | Build flags |
|---|---|---|---|---|---|---|
{chr(10).join(native_runtime_rows)}

Dart executed runtime:

- sherpa C API: `{dart_provenance["runtime"]["sherpaCApiSha256"]}`
- ORT 1.27.0: `{dart_provenance["runtime"]["onnxRuntimeSha256"]}`
- current worker: `{dart_provenance["currentWorker"]["workerSha256"]}`
- current sandbox launcher: `{dart_provenance["currentWorker"]["sandboxedLauncherSha256"]}`
- current process-group launcher: `{dart_provenance["currentWorker"]["nativeProcessGroupLauncherSha256"]}`
- diagnostic worker binary: `{dart_provenance["diagnosticWorker"]["workerSha256"]}`
- diagnostic worker source: `{dart_provenance["diagnosticWorker"]["workerSourceSha256"]}`
- diagnostic sandbox launcher: `{dart_provenance["diagnosticWorker"]["sandboxedLauncherSha256"]}`
- diagnostic process-group launcher: `{dart_provenance["diagnosticWorker"]["nativeProcessGroupLauncherSha256"]}`
- resource sampler: `{report["provenance"]["resourceSamplerSha256"]}`

Assets:

- official audio SHA-256: `{report["assets"]["audio"]["sha256"]}`
- official audio disposition: `{report["assets"]["audio"]["licenseDisposition"]}`
- Silero VAD SHA-256: `{report["assets"]["sileroVadSha256"]}`
{model_hash_lines}

## Limitations and privacy

Official hardware/build flags are unknown; the page-era runtime is a proxy; bootstrap intervals have only 3–5 measured runs; sampler and thread probes are descriptive. Qwen GPU/vLLM concurrency throughput is intentionally excluded because it is not a single-stream M4 CPU latency baseline.

No transcript, reference text, audio, model, raw log, credential, token, cookie, or local absolute path is published.
"""


def verify_published_pair(json_path: Path, markdown_path: Path) -> None:
    report = _load(json_path)
    markdown_bytes = markdown_path.read_bytes()
    markdown = markdown_bytes.decode("utf-8")
    publication_id = report.get("publicationId")
    evidence_hash = report.get("boundedSummarySha256")
    _require(
        f"Publication ID: `{publication_id}`" in markdown,
        "published JSON/Markdown publicationId mismatch",
    )
    _require(
        f"Bounded evidence SHA-256: `{evidence_hash}`" in markdown,
        "published JSON/Markdown evidence hash mismatch",
    )
    _require(
        report.get("markdownSha256") == sha256_bytes(markdown_bytes),
        "published JSON does not bind the complete Markdown bytes",
    )
    if report.get("kind") == "m4_qwen3_official_rtf_reproduction":
        _require(
            build_markdown(report) == markdown,
            "published Markdown is not the deterministic rendering of JSON",
        )
    _privacy_validate(report, markdown)


def _restore_file(path: Path, previous: bytes | None) -> None:
    if previous is None:
        path.unlink(missing_ok=True)
        return
    with tempfile.NamedTemporaryFile(
        "wb", dir=path.parent, delete=False
    ) as handle:
        handle.write(previous)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def publish_pair(
    report: dict[str, Any],
    markdown: str,
    *,
    json_path: Path,
    markdown_path: Path,
    replace_fn: Callable[[Path, Path], None] | None = None,
) -> None:
    replace = replace_fn or os.replace
    _require(
        report.get("markdownSha256") == sha256_bytes(markdown.encode("utf-8")),
        "report does not bind the Markdown to be published",
    )
    json_bytes = (
        json.dumps(
            report,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    markdown_bytes = markdown.encode("utf-8")
    previous_json = json_path.read_bytes() if json_path.exists() else None
    previous_markdown = (
        markdown_path.read_bytes() if markdown_path.exists() else None
    )
    json_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "wb", dir=json_path.parent, delete=False
    ) as json_handle:
        json_handle.write(json_bytes)
        json_temporary = Path(json_handle.name)
    with tempfile.NamedTemporaryFile(
        "wb", dir=markdown_path.parent, delete=False
    ) as markdown_handle:
        markdown_handle.write(markdown_bytes)
        markdown_temporary = Path(markdown_handle.name)
    try:
        replace(markdown_temporary, markdown_path)
        replace(json_temporary, json_path)
        verify_published_pair(json_path, markdown_path)
    except BaseException:
        _restore_file(json_path, previous_json)
        _restore_file(markdown_path, previous_markdown)
        raise
    finally:
        json_temporary.unlink(missing_ok=True)
        markdown_temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--bounded-summary",
        type=Path,
        default=(
            REPOSITORY_ROOT
            / "build/desktop_asr_comparison/m4/official-rtf-repro/bounded_summary.json"
        ),
    )
    args = parser.parse_args()
    bounded_path = args.bounded_summary.resolve(strict=True)
    bounded = _load(bounded_path)
    experiment = _load(COMPARISON_ROOT / "qwen3_experiment_m4.json")
    freeze = _load(COMPARISON_ROOT / "qwen3_m4_development_freeze.json")
    validate_bounded(
        bounded,
        repository_root=REPOSITORY_ROOT,
        bounded_path=bounded_path,
        experiment=experiment,
    )
    report = build_report(
        bounded,
        experiment,
        freeze,
        bounded_summary_sha256=sha256_file(bounded_path),
        builder_sha256=sha256_file(Path(__file__)),
    )
    markdown = build_markdown(report)
    report["markdownSha256"] = sha256_bytes(markdown.encode("utf-8"))
    _require(
        build_markdown(report) == markdown,
        "Markdown rendering depends on its own publication hash",
    )
    _privacy_validate(report, markdown)
    publish_pair(
        report,
        markdown,
        json_path=REPORT_JSON,
        markdown_path=REPORT_MARKDOWN,
    )
    print(
        json.dumps(
            {
                "kind": report["kind"],
                "outcome": report["outcome"],
                "publicationId": report["publicationId"],
                "boundedSummarySha256": report["boundedSummarySha256"],
            },
            sort_keys=True,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
