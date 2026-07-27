#!/usr/bin/env python3
"""Run the local-only Apple M4 Qwen3 official-RTF reproduction lanes."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from resource_sampler import ProcessTreeSampler
from run_expanded_stage0 import _capabilities, _tokenizer_tree_hash
from run_macos_asr_comparison import (
    canonical_json,
    execute_run,
    sha256_bytes,
    sha256_file,
    terminate_process_group,
)
from run_qwen3_m4_experiment import CANDIDATE_ID, effective_config


SCHEMA_VERSION = 2
AUDIO_DURATION_SECONDS = 334.2345
OFFICIAL_AUDIO_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "asr-models/Obama.wav"
)
OFFICIAL_PAGE_URL = (
    "https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html"
)
OFFICIAL_RTF = 0.103
OFFICIAL_ELAPSED_SECONDS = 34.480
NATIVE_ELAPSED_RE = re.compile(r"Elapsed seconds:\s+([0-9.]+)\s+s")
NATIVE_RTF_RE = re.compile(
    r"Real time factor \(RTF\):\s+([0-9.]+)\s+/\s+([0-9.]+)\s+=\s+([0-9.]+)"
)
NATIVE_SEGMENT_RE = re.compile(r"^([0-9.]+)\s+--\s+([0-9.]+):")

METRIC_REASON_CODES = {
    "segmentLatencyP50Milliseconds": "native_cli_does_not_emit_detector_latency",
    "segmentLatencyP95Milliseconds": "native_cli_does_not_emit_detector_latency",
    "outputTokenCount": "native_cli_does_not_emit_token_census",
    "tokensPerAudioSecond": "native_cli_does_not_emit_token_census",
    "nativeResultFetchMilliseconds": "native_cli_does_not_expose_conversion_timer",
    "ffiStringCopyMilliseconds": "native_cli_does_not_expose_conversion_timer",
    "jsonRepairAndDecodeMilliseconds": "native_cli_does_not_expose_conversion_timer",
    "resultConversionMilliseconds": "native_cli_does_not_expose_conversion_timer",
    "vadMilliseconds": "native_cli_elapsed_includes_vad_indivisibly",
    "recognizerDecodeMilliseconds": "native_cli_elapsed_is_indivisible_processing_time",
    "retainedRssBytesAfterUnload": "native_process_has_exited",
}
PUBLISHABLE_OBSERVATION_KEYS = {
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
    "timingSemantics",
    "tokensPerAudioSecond",
    "threads",
    "vadMilliseconds",
    "warmup",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _run_execution_id(
    execution_id: str, lane_id: str, run_index: int, warmup: bool
) -> str:
    material = f"{execution_id}|{lane_id}|{run_index}|{int(warmup)}".encode()
    return sha256_bytes(material)[:32]


def _metric_state(
    support: str, reason_code: str
) -> dict[str, str]:
    require(support in {"unsupported", "not_applicable"}, "invalid metric support")
    require(bool(reason_code), "metric support reason is required")
    return {"support": support, "reasonCode": reason_code}


def _publishable_observation(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in item.items()
        if key in PUBLISHABLE_OBSERVATION_KEYS
    }


class ReproductionError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReproductionError(message)


def diagnostic_segmentation_schedule(
    fixed_lane: str, vad_lane: str
) -> dict[str, Any]:
    return {
        "design": "alternating_after_equal_lane_warmups",
        "warmupOrder": [fixed_lane, vad_lane],
        "measuredOrder": [
            lane_id
            for _ in range(5)
            for lane_id in (fixed_lane, vad_lane)
        ],
        "scheduleOrderStart": 0,
    }


def percentile(values: list[float], quantile: float) -> float:
    require(bool(values), "percentile requires observations")
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def bootstrap_median_ci(
    values: list[float], *, samples: int = 10_000
) -> list[float]:
    require(bool(values), "bootstrap CI requires observations")
    import random

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


def summarize_observations(
    observations: list[dict[str, Any]],
) -> dict[str, Any]:
    measured = [item for item in observations if not item["warmup"]]
    warmups = [item for item in observations if item["warmup"]]
    require(bool(measured), "lane requires measured observations")
    metrics = (
        "loadMilliseconds",
        "decodeMilliseconds",
        "recognizerDecodeMilliseconds",
        "endToEndWallMilliseconds",
        "processWallMilliseconds",
        "officialComparableProcessingMilliseconds",
        "officialComparableRtf",
        "cliReportedRtf",
        "rtf",
        "segmentLatencyP50Milliseconds",
        "segmentLatencyP95Milliseconds",
        "absolutePeakRssBytes",
        "incrementalPeakRssBytes",
        "retainedRssBytesAfterUnload",
        "outputTokenCount",
        "tokensPerAudioSecond",
        "nativeResultFetchMilliseconds",
        "ffiStringCopyMilliseconds",
        "jsonRepairAndDecodeMilliseconds",
        "resultConversionMilliseconds",
        "vadMilliseconds",
        "detectorSegmentCount",
        "emittedResultSegmentCount",
        "emittedResultSpeechDurationSeconds",
    )
    result: dict[str, Any] = {
        "warmupRunCount": len(warmups),
        "measuredRunCount": len(measured),
        "warmupObservations": [
            _publishable_observation(item) for item in warmups
        ],
        "observations": [
            _publishable_observation(item) for item in measured
        ],
        "metrics": {},
    }
    for key in metrics:
        values = [
            float(item[key])
            for item in measured
            if isinstance(item.get(key), (int, float))
            and not isinstance(item.get(key), bool)
        ]
        if not values:
            states = [
                item.get("metricSupport", {}).get(key)
                for item in measured
                if item.get("metricSupport", {}).get(key) is not None
            ]
            require(states, f"missing support state for metric {key}")
            require(
                all(state == states[0] for state in states),
                f"inconsistent support state for metric {key}",
            )
            result["metrics"][key] = states[0]
            continue
        result["metrics"][key] = {
            "support": "measured",
            "count": len(values),
            "median": statistics.median(values),
            "p95": percentile(values, 0.95),
            "minimum": min(values),
            "maximum": max(values),
            "median95PercentBootstrapCI": bootstrap_median_ci(values),
        }
    median_rtf = result["metrics"]["rtf"]["median"]
    result["officialComparison"] = {
        "officialRtf": OFFICIAL_RTF,
        "medianRtfRatio": median_rtf / OFFICIAL_RTF,
        "medianRtfAbsoluteDifference": median_rtf - OFFICIAL_RTF,
    }
    return result


def parse_native_output(
    stdout: str,
    stderr: str,
    *,
    external_wall_milliseconds: float,
    marker_times: dict[str, float],
    resources: dict[str, Any] | None,
) -> dict[str, Any]:
    elapsed_match = NATIVE_ELAPSED_RE.search(stderr)
    rtf_match = NATIVE_RTF_RE.search(stderr)
    require(elapsed_match is not None, "native CLI elapsed time is missing")
    require(rtf_match is not None, "native CLI RTF is missing")
    elapsed_seconds = float(elapsed_match.group(1))
    denominator = float(rtf_match.group(2))
    cli_reported_rtf = float(rtf_match.group(3))
    official_comparable_rtf = elapsed_seconds / denominator
    require(
        abs(denominator - 334.234) < 0.001,
        "native CLI decoded an unexpected duration",
    )
    emitted_segments = [
        (float(match.group(1)), float(match.group(2)))
        for line in stdout.splitlines()
        if (match := NATIVE_SEGMENT_RE.match(line))
    ]
    segment_durations = [end - start for start, end in emitted_segments]
    load_milliseconds = None
    if "loadStart" in marker_times and "loadComplete" in marker_times:
        load_milliseconds = (
            marker_times["loadComplete"] - marker_times["loadStart"]
        ) * 1000
    end_to_end_milliseconds = external_wall_milliseconds
    if "inputStart" in marker_times and "resultComplete" in marker_times:
        end_to_end_milliseconds = (
            marker_times["resultComplete"] - marker_times["inputStart"]
        ) * 1000
    return {
        "decodeMilliseconds": elapsed_seconds * 1000,
        "recognizerDecodeMilliseconds": None,
        "officialComparableProcessingMilliseconds": elapsed_seconds * 1000,
        "officialComparableRtf": official_comparable_rtf,
        "endToEndWallMilliseconds": end_to_end_milliseconds,
        "processWallMilliseconds": external_wall_milliseconds,
        "rtf": official_comparable_rtf,
        "cliReportedRtf": cli_reported_rtf,
        "loadMilliseconds": load_milliseconds,
        "segmentLatencyP50Milliseconds": None,
        "segmentLatencyP95Milliseconds": None,
        "emittedResultSegmentCount": len(emitted_segments),
        "emittedResultSpeechDurationSeconds": sum(segment_durations),
        "emittedResultSegmentDurationP50Seconds": (
            statistics.median(segment_durations) if segment_durations else None
        ),
        "emittedResultSegmentDurationP95Seconds": (
            percentile(segment_durations, 0.95) if segment_durations else None
        ),
        "detectorSegmentCount": None,
        "outputTokenCount": None,
        "tokensPerAudioSecond": None,
        "nativeResultFetchMilliseconds": None,
        "ffiStringCopyMilliseconds": None,
        "jsonRepairAndDecodeMilliseconds": None,
        "resultConversionMilliseconds": None,
        "vadMilliseconds": None,
        "absolutePeakRssBytes": (
            resources["absolutePeakRssBytes"] if resources else None
        ),
        "incrementalPeakRssBytes": (
            resources["incrementalPeakRssBytes"] if resources else None
        ),
        "retainedRssBytesAfterUnload": None,
        "resourceSampler": resources,
        "timingSemantics": {
            "decodeMilliseconds": (
                "official_cli_elapsed_includes_vad_decode_and_file_processing"
            ),
            "recognizerDecodeMilliseconds": "unsupported_indivisible_native_cli",
            "endToEndWallMilliseconds": "input_release_to_result_marker",
            "processWallMilliseconds": "input_release_to_process_exit",
        },
        "metricSupport": {
            **{
                key: _metric_state("unsupported", reason)
                for key, reason in METRIC_REASON_CODES.items()
                if key != "retainedRssBytesAfterUnload"
            },
            **(
                {
                    "absolutePeakRssBytes": _metric_state(
                        "unsupported", "resource_sampler_disabled"
                    ),
                    "incrementalPeakRssBytes": _metric_state(
                        "unsupported", "resource_sampler_disabled"
                    ),
                }
                if resources is None
                else {}
            ),
            "retainedRssBytesAfterUnload": _metric_state(
                "not_applicable", METRIC_REASON_CODES["retainedRssBytesAfterUnload"]
            ),
            "detectorSegmentCount": _metric_state(
                "unsupported", "stdout_segments_are_emitted_results_not_detector_census"
            ),
        },
    }


def _consume_lines(
    stream: Any,
    destination: list[str],
    marker: Callable[[str], None] | None = None,
) -> None:
    for line in stream:
        destination.append(line)
        if marker is not None:
            marker(line)


def native_command(
    *,
    executable: Path,
    model_root: Path,
    silero_model: Path,
    audio: Path,
    threads: int,
    supports_hotwords: bool = True,
) -> list[str]:
    command = [
        str(executable),
        f"--silero-vad-model={silero_model}",
        "--silero-vad-threshold=0.2",
        "--silero-vad-min-silence-duration=0.5",
        "--silero-vad-min-speech-duration=0.2",
        "--silero-vad-max-speech-duration=20",
        f"--qwen3-asr-conv-frontend={model_root / 'conv_frontend.onnx'}",
        f"--qwen3-asr-encoder={model_root / 'encoder.int8.onnx'}",
        f"--qwen3-asr-decoder={model_root / 'decoder.int8.onnx'}",
        f"--qwen3-asr-tokenizer={model_root / 'tokenizer'}",
        "--qwen3-asr-max-total-len=512",
        "--qwen3-asr-max-new-tokens=512",
        "--qwen3-asr-temperature=0.000001",
        "--qwen3-asr-top-p=0.8",
        "--qwen3-asr-seed=42",
        "--provider=cpu",
        f"--num-threads={threads}",
        "--debug=false",
        str(audio),
    ]
    if supports_hotwords:
        command.insert(-4, "--qwen3-asr-hotwords=")
    return command


def run_native_once(
    *,
    command: list[str],
    output_root: Path,
    lane_id: str,
    run_index: int,
    warmup: bool,
    sampler_interval_seconds: float | None,
    execution_id: str = "unit-test-execution",
    timeout_seconds: float = 300,
    schedule_order: int | None = None,
) -> dict[str, Any]:
    run_name = f"{lane_id}-{'warmup' if warmup else f'measured-{run_index}'}"
    run_execution_id = _run_execution_id(
        execution_id, lane_id, run_index, warmup
    )
    started_at = utc_now()
    stdout_path = output_root / "raw" / f"{run_name}.stdout.log"
    stderr_path = output_root / "raw" / f"{run_name}.stderr.log"
    failure_path = output_root / "failures" / f"{run_name}.json"
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    wrapper = ["/bin/sh", "-c", 'read ready; exec "$@"', "sh", *command]
    spawned = time.monotonic()
    process = subprocess.Popen(
        wrapper,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        bufsize=1,
    )
    sampler = (
        ProcessTreeSampler(
            process.pid,
            interval_seconds=sampler_interval_seconds,
            temporary_root=output_root / "temporary",
        )
        if sampler_interval_seconds is not None
        else None
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    marker_times: dict[str, float] = {}
    stdout_thread: threading.Thread | None = None
    stderr_thread: threading.Thread | None = None
    resources: dict[str, Any] | None = None
    termination: dict[str, Any] | None = None
    failure: BaseException | None = None
    exit_code: int | None = None
    wall_milliseconds = 0.0

    def marker(line: str) -> None:
        now = time.monotonic()
        if "Creating recognizer ..." in line:
            marker_times.setdefault("loadStart", now)
        elif "Recognizer created!" in line:
            marker_times.setdefault("loadComplete", now)
        elif line.strip() == "Started!":
            marker_times.setdefault("decodeStart", now)
        elif NATIVE_RTF_RE.search(line):
            marker_times.setdefault("resultComplete", now)

    try:
        if sampler is not None:
            sampler.start()
            sampler.freeze_baseline()
        assert process.stdout is not None
        assert process.stderr is not None
        stdout_thread = threading.Thread(
            target=_consume_lines,
            args=(process.stdout, stdout_lines),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=_consume_lines,
            args=(process.stderr, stderr_lines, marker),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()
        assert process.stdin is not None
        marker_times["inputStart"] = time.monotonic()
        process.stdin.write("go\n")
        process.stdin.close()
        exit_code = process.wait(timeout=timeout_seconds)
    except BaseException as error:
        failure = error
        if process.poll() is None:
            termination = terminate_process_group(process)
    finally:
        wall_milliseconds = (time.monotonic() - spawned) * 1000
        if process.poll() is None:
            termination = terminate_process_group(process)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            termination = terminate_process_group(process, grace_seconds=0)
            process.wait(timeout=2)
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        for thread in (stdout_thread, stderr_thread):
            if thread is not None:
                thread.join(timeout=2)
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()
        if sampler is not None:
            try:
                resources = sampler.stop()
            except Exception as sampler_error:
                if failure is None:
                    failure = sampler_error
    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    stdout_path.write_text(stdout, encoding="utf-8")
    stderr_path.write_text(stderr, encoding="utf-8")
    completed_at = utc_now()
    if failure is not None:
        failure_code = (
            "TIMEOUT"
            if isinstance(failure, subprocess.TimeoutExpired)
            else "NATIVE_EXECUTION_ERROR"
        )
        _atomic_json(
            failure_path,
            {
                "schemaVersion": SCHEMA_VERSION,
                "kind": "m4_qwen3_native_failure_evidence",
                "outcome": "FAILED",
                "executionId": run_execution_id,
                "startedAt": started_at,
                "completedAt": completed_at,
                "failureCode": failure_code,
                "rawStdoutSha256": sha256_file(stdout_path),
                "rawStderrSha256": sha256_file(stderr_path),
                "termination": termination,
            },
        )
        raise failure
    if exit_code != 0:
        _atomic_json(
            failure_path,
            {
                "schemaVersion": SCHEMA_VERSION,
                "kind": "m4_qwen3_native_failure_evidence",
                "outcome": "FAILED",
                "executionId": run_execution_id,
                "startedAt": started_at,
                "completedAt": completed_at,
                "failureCode": "NONZERO_EXIT",
                "exitCode": exit_code,
                "rawStdoutSha256": sha256_file(stdout_path),
                "rawStderrSha256": sha256_file(stderr_path),
                "termination": termination,
            },
        )
        raise ReproductionError(f"native CLI failed with status {exit_code}")
    try:
        observation = parse_native_output(
            stdout,
            stderr,
            external_wall_milliseconds=wall_milliseconds,
            marker_times=marker_times,
            resources=resources,
        )
    except (ReproductionError, ValueError) as error:
        _atomic_json(
            failure_path,
            {
                "schemaVersion": SCHEMA_VERSION,
                "kind": "m4_qwen3_native_failure_evidence",
                "outcome": "FAILED",
                "executionId": run_execution_id,
                "startedAt": started_at,
                "completedAt": completed_at,
                "failureCode": "INVALID_NATIVE_OUTPUT",
                "rawStdoutSha256": sha256_file(stdout_path),
                "rawStderrSha256": sha256_file(stderr_path),
                "termination": termination,
            },
        )
        raise error
    observation.update(
        {
            "runIndex": run_index,
            "laneId": lane_id,
            "warmup": warmup,
            "scheduleOrder": (
                run_index if schedule_order is None else schedule_order
            ),
            "executionId": run_execution_id,
            "startedAt": started_at,
            "completedAt": completed_at,
            "rawStdoutSha256": sha256_file(stdout_path),
            "rawStderrSha256": sha256_file(stderr_path),
            "samplerIntervalMilliseconds": (
                sampler_interval_seconds * 1000
                if sampler_interval_seconds is not None
                else None
            ),
        }
    )
    observation_record_path = (
        output_root / "raw" / f"{run_name}.observation.json"
    )
    _atomic_json(
        observation_record_path,
        {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "m4_qwen3_native_observation_binding",
            "observation": _publishable_observation(observation),
        },
    )
    observation["rawEvidence"] = {
        "kind": "native_cli_logs",
        "stdoutRelativePath": f"raw/{stdout_path.name}",
        "stdoutSha256": sha256_file(stdout_path),
        "stderrRelativePath": f"raw/{stderr_path.name}",
        "stderrSha256": sha256_file(stderr_path),
        "observationRecordRelativePath": (
            f"raw/{observation_record_path.name}"
        ),
        "observationRecordSha256": sha256_file(observation_record_path),
    }
    return observation


def _model_files(
    experiment: dict[str, Any],
    model_root: Path,
    *,
    silero_model: Path | None = None,
) -> dict[str, dict[str, str]]:
    model_files: dict[str, dict[str, str]] = {}
    for role, binding in experiment["candidate"]["artifacts"].items():
        path = model_root / binding["relativePath"]
        actual = (
            _tokenizer_tree_hash(path)
            if role == "tokenizer"
            else sha256_file(path)
        )
        require(actual == binding["sha256"], f"model hash mismatch: {role}")
        model_files[role] = {"path": str(path), "sha256": actual}
    if silero_model is not None:
        model_files["sileroVad"] = {
            "path": str(silero_model),
            "sha256": sha256_file(silero_model),
        }
    return model_files


def _finite_nonnegative(value: Any, field: str) -> float:
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) >= 0,
        f"diagnostic result {field} must be finite and nonnegative",
    )
    return float(value)


def validate_diagnostic_result(
    result_event: dict[str, Any], *, audio_duration_seconds: float
) -> None:
    timing_fields = (
        "decodeMilliseconds",
        "vadMilliseconds",
        "nativeResultFetchMilliseconds",
        "ffiStringCopyMilliseconds",
        "jsonRepairAndDecodeMilliseconds",
        "resultConversionMilliseconds",
    )
    for field in timing_fields:
        _finite_nonnegative(result_event.get(field), field)
    count = result_event.get("segmentCount")
    require(
        isinstance(count, int) and not isinstance(count, bool) and count > 0,
        "diagnostic result segmentCount must be a positive integer",
    )
    tokens = result_event.get("tokens")
    require(
        isinstance(tokens, list) and all(isinstance(token, str) for token in tokens),
        "diagnostic result tokens must be a string array",
    )
    output_token_count = result_event.get("outputTokenCount")
    require(
        isinstance(output_token_count, int)
        and not isinstance(output_token_count, bool)
        and output_token_count == len(tokens),
        "diagnostic result outputTokenCount does not match tokens",
    )
    arrays = {
        "segmentWallMilliseconds": result_event.get("segmentWallMilliseconds"),
        "segmentDurationsSeconds": result_event.get("segmentDurationsSeconds"),
        "segmentStartSeconds": result_event.get("segmentStartSeconds"),
    }
    for field, values in arrays.items():
        require(
            isinstance(values, list) and len(values) == count,
            f"diagnostic result {field} length does not match segmentCount",
        )
        for value in values:
            _finite_nonnegative(value, field)
    starts = [float(value) for value in arrays["segmentStartSeconds"]]
    durations = [float(value) for value in arrays["segmentDurationsSeconds"]]
    require(starts == sorted(starts), "diagnostic segment starts must be ordered")
    previous_end = 0.0
    for start, duration in zip(starts, durations, strict=True):
        require(duration > 0, "diagnostic segment duration must be positive")
        require(
            start + duration <= audio_duration_seconds + 1 / 16000,
            "diagnostic segment exceeds source duration",
        )
        require(
            start + 1 / 16000 >= previous_end,
            "diagnostic segments overlap or are out of order",
        )
        previous_end = start + duration


def run_dart_once(
    *,
    repository_root: Path,
    experiment: dict[str, Any],
    model_root: Path,
    runtime_root: Path,
    tool_root: Path,
    worker: Path,
    audio: Path,
    output_root: Path,
    lane_id: str,
    profile_id: str,
    run_index: int,
    warmup: bool,
    segmentation: str,
    silero_model: Path | None = None,
    execution_id: str = "unit-test-execution",
    diagnostic_worker: bool = False,
    schedule_order: int | None = None,
) -> dict[str, Any]:
    run_execution_id = _run_execution_id(
        execution_id, lane_id, run_index, warmup
    )
    started_at = utc_now()
    job_root = output_root / "jobs" / (
        f"{lane_id}-{'warmup' if warmup else f'measured-{run_index}'}"
    )
    shutil.rmtree(job_root, ignore_errors=True)
    source_root = job_root / "input"
    source_root.mkdir(parents=True)
    source = source_root / "audio.wav"
    shutil.copyfile(audio, source)
    source_sha256 = sha256_file(source)
    model_files = _model_files(
        experiment,
        model_root,
        silero_model=silero_model,
    )
    config = effective_config(
        "fixed-resource"
        if segmentation == "fixed_15_seconds"
        else "official-recommended"
    )
    request: dict[str, Any] = {
        "roots": {
            "jobRoot": str(job_root),
            "runtimeRoot": str(runtime_root),
            "modelRoot": str(model_root),
            "toolRoot": str(tool_root),
        },
        "nativeProcessGroupLauncher": str(
            tool_root / "native_process_group_launcher"
        ),
        "worker": str(worker),
        "workerRequest": {
            "schemaVersion": 2,
            "candidateId": CANDIDATE_ID,
            "family": "qwen3_asr",
            "profileId": profile_id,
            "sourcePath": str(source),
            "sourceSha256": source_sha256,
            "modelFiles": model_files,
            "effectiveConfig": config,
            "capabilities": _capabilities("qwen3_asr"),
            "expectSpeech": True,
            "settleMilliseconds": 1000,
            **(
                {"diagnosticSegmentation": segmentation}
                if diagnostic_worker
                else {}
            ),
        },
    }
    specification = {
        "candidateId": CANDIDATE_ID,
        "profileId": profile_id,
        "fixtureId": "sherpa-official-obama-334s",
        "laneId": lane_id,
        "scorecard": "diagnostic_core_asr",
        "scenario": "official_public_long_audio",
        "rankEligible": False,
        "observationSource": "m4_qwen3_official_rtf_reproduction",
        "pacingPolicy": "unpaced",
        "reference": "",
        "sourceSha256": source_sha256,
        "runIndex": run_index,
        "warmup": warmup,
        "scheduleOrder": run_index if schedule_order is None else schedule_order,
        "executionId": run_execution_id,
    }
    binding = {
        "contractSha256": sha256_file(Path(__file__)),
        "candidateRegistrySha256": sha256_file(
            repository_root
            / "benchmark/desktop/asr_comparison/qwen3_experiment_m4.json"
        ),
        "scoringContractSha256": sha256_file(
            repository_root
            / "benchmark/desktop/asr_comparison/scoring_contract.json"
        ),
        "scorerSha256": sha256_file(
            repository_root
            / "benchmark/desktop/asr_comparison/asr_scoring.py"
        ),
        "runtimeSha256": sha256_file(
            runtime_root / "libsherpa-onnx-c-api.dylib"
        ),
        "workerSha256": sha256_file(worker),
        "fixtureSha256": source_sha256,
        "referenceSha256": sha256_bytes(b""),
        "profileSha256": sha256_bytes(
            canonical_json(
                {
                    "diagnosticLaneId": lane_id,
                    "executionId": run_execution_id,
                    "config": config,
                    "onnxRuntimeSha256": sha256_file(
                        runtime_root / "libonnxruntime.1.27.0.dylib"
                    ),
                    "launcherSha256": sha256_file(
                        tool_root / "sandboxed_candidate_launcher"
                    ),
                    "processGroupSha256": sha256_file(
                        tool_root / "native_process_group_launcher"
                    ),
                    "modelSha256": {
                        role: value["sha256"]
                        for role, value in model_files.items()
                    },
                }
            )
        ),
    }
    try:
        record = execute_run(
            command=[str(tool_root / "sandboxed_candidate_launcher")],
            request=request,
            specification=specification,
            binding=binding,
            run_root=output_root / "runs",
            raw_root=output_root / "raw",
            timeout_seconds=300,
            sampler_interval_seconds=0.02,
        )
        require(
            record.get("resumed") is False,
            "formal reproduction requires a fresh non-resumed Dart execution",
        )
        raw = json.loads(
            (output_root / "raw" / f"{record['runId']}.json").read_text(
                encoding="utf-8"
            )
        )
        result_event = next(
            event for event in raw["events"] if event["type"] == "result"
        )
        if diagnostic_worker:
            validate_diagnostic_result(
                result_event,
                audio_duration_seconds=AUDIO_DURATION_SECONDS,
            )
        token_count = len(result_event["tokens"])
        vad_milliseconds = result_event.get("vadMilliseconds")
        official_processing = float(record["metrics"]["decodeMilliseconds"])
        if diagnostic_worker and vad_milliseconds is not None:
            official_processing += float(vad_milliseconds)
        metric_support: dict[str, dict[str, str]] = {}
        unsupported = {
            "cliReportedRtf": "dart_worker_does_not_emit_cli_rounded_rtf",
            "nativeResultFetchMilliseconds": "current_worker_has_no_conversion_extension",
            "ffiStringCopyMilliseconds": "current_worker_has_no_conversion_extension",
            "jsonRepairAndDecodeMilliseconds": "current_worker_has_no_conversion_extension",
            "resultConversionMilliseconds": "current_worker_has_no_conversion_extension",
            "vadMilliseconds": "current_worker_has_no_segmentation_timer",
            "detectorSegmentCount": "current_worker_has_no_detector_census",
            "emittedResultSegmentCount": "dart_worker_result_is_not_native_cli_stdout",
            "emittedResultSpeechDurationSeconds": "dart_worker_result_is_not_native_cli_stdout",
        }
        for field, reason in unsupported.items():
            if result_event.get(field) is None:
                metric_support[field] = _metric_state("unsupported", reason)
        observation = {
            **record["metrics"],
            "runIndex": run_index,
            "laneId": lane_id,
            "warmup": warmup,
            "executionId": run_execution_id,
            "startedAt": started_at,
            "completedAt": utc_now(),
            "resumed": bool(record["resumed"]),
            "scheduleOrder": (
                run_index if schedule_order is None else schedule_order
            ),
            "rawOutputSha256": record["rawOutputSha256"],
            "outputTokenCount": token_count,
            "tokensPerAudioSecond": token_count / AUDIO_DURATION_SECONDS,
            "recognizerDecodeMilliseconds": record["metrics"][
                "decodeMilliseconds"
            ],
            "officialComparableProcessingMilliseconds": official_processing,
            "officialComparableRtf": (
                official_processing / (AUDIO_DURATION_SECONDS * 1000)
            ),
            "segmentCount": result_event["segmentCount"],
            "segmentDurationsSeconds": result_event.get(
                "segmentDurationsSeconds"
            ),
            "vadMilliseconds": vad_milliseconds,
            "nativeResultFetchMilliseconds": result_event.get(
                "nativeResultFetchMilliseconds"
            ),
            "ffiStringCopyMilliseconds": result_event.get(
                "ffiStringCopyMilliseconds"
            ),
            "jsonRepairAndDecodeMilliseconds": result_event.get(
                "jsonRepairAndDecodeMilliseconds"
            ),
            "resultConversionMilliseconds": result_event.get(
                "resultConversionMilliseconds"
            ),
            "resources": record["resources"],
            "rawEvidence": {
                "kind": "dart_execute_run",
                "runId": record["runId"],
                "runRecordRelativePath": f"runs/{record['runId']}.json",
                "runRecordSha256": sha256_file(
                    output_root / "runs" / f"{record['runId']}.json"
                ),
                "rawRecordRelativePath": f"raw/{record['runId']}.json",
                "rawRecordSha256": sha256_file(
                    output_root / "raw" / f"{record['runId']}.json"
                ),
            },
            "timingSemantics": {
                "decodeMilliseconds": (
                    "worker_decode_phase_includes_stream_setup_accept_decode_"
                    "result_conversion_and_stream_free_excludes_segmentation"
                ),
                "endToEndWallMilliseconds": "input_write_to_first_result",
                "processWallMilliseconds": "spawn_to_complete_event",
                "officialComparableProcessingMilliseconds": (
                    "decode_plus_vad"
                    if segmentation == "official_silero_vad"
                    else "decode_plus_fixed_segmentation_timer_if_exposed"
                ),
            },
            "metricSupport": metric_support,
        }
        return observation
    finally:
        shutil.rmtree(job_root, ignore_errors=True)


def _atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
    ) as handle:
        json.dump(
            document,
            handle,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _native_runtime_provenance(
    local_root: Path, definitions: list[dict[str, Any]]
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for definition in definitions:
        archive = local_root / "download" / definition["archiveName"]
        executed_root = local_root / definition["executedRoot"]
        original_root = local_root / definition["originalRoot"]
        executed = {
            "cliSha256": sha256_file(
                executed_root / "bin/sherpa-onnx-vad-with-offline-asr"
            ),
            "sherpaCApiSha256": sha256_file(
                executed_root / "lib/libsherpa-onnx-c-api.dylib"
            ),
            "onnxRuntimeSha256": sha256_file(
                executed_root / "lib" / definition["onnxRuntimeLibrary"]
            ),
        }
        original = {
            "cliSha256": sha256_file(
                original_root / "bin/sherpa-onnx-vad-with-offline-asr"
            ),
            "sherpaCApiSha256": sha256_file(
                original_root / "lib/libsherpa-onnx-c-api.dylib"
            ),
            "onnxRuntimeSha256": sha256_file(
                original_root / "lib" / definition["onnxRuntimeLibrary"]
            ),
        }
        archive_hash = sha256_file(archive)
        require(
            archive_hash == definition["expectedArchiveSha256"],
            f"native archive hash mismatch: {definition['laneId']}",
        )
        result[definition["laneId"]] = {
            "archiveFileName": definition["archiveName"],
            "archiveSha256": archive_hash,
            "originalArtifactHashes": original,
            "executedAdHocSignedArtifactHashes": executed,
            "executionDisposition": "local_ad_hoc_signed_copy",
            "sherpaOnnxVersion": definition["sherpaOnnxVersion"],
            "sherpaOnnxGitSha1": definition["sherpaOnnxGitSha1"],
            "onnxRuntimeVersion": definition["onnxRuntimeVersion"],
            "nativeBuildFlags": {
                "support": "unsupported",
                "reasonCode": "prebuilt_archive_does_not_publish_complete_flags",
            },
        }
    return result


def _host_metadata() -> dict[str, Any]:
    def sysctl(name: str) -> str:
        return subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", name], text=True
        ).strip()

    return {
        "cpu": sysctl("machdep.cpu.brand_string"),
        "memoryBytes": int(sysctl("hw.memsize")),
        "operatingSystem": platform.platform(),
        "architecture": platform.machine(),
    }


def execute(args: argparse.Namespace) -> dict[str, Any]:
    execution_id = uuid.uuid4().hex
    started_at = utc_now()
    root = args.root.resolve(strict=True)
    comparison_root = root / "benchmark/desktop/asr_comparison"
    local_root = (
        root / "build/desktop_asr_comparison/m4/official-rtf-repro"
    )
    download_root = local_root / "download"
    model_root = (
        root
        / "build/desktop_asr_comparison/m4/qwen3/extracted/"
        "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
    )
    audio = download_root / "Obama.wav"
    silero_model = download_root / "silero_vad.onnx"
    model_silero = model_root / "silero_vad.onnx"
    if not model_silero.exists():
        shutil.copyfile(silero_model, model_silero)
    require(
        sha256_file(model_silero) == sha256_file(silero_model),
        "model-local Silero VAD hash mismatch",
    )
    experiment = json.loads(
        (comparison_root / "qwen3_experiment_m4.json").read_text(
            encoding="utf-8"
        )
    )
    require(sha256_file(audio) == args.expected_audio_sha256, "audio hash mismatch")
    require(
        abs(_wave_duration(audio) - AUDIO_DURATION_SECONDS) < 0.0001,
        "audio duration mismatch",
    )
    native_definitions = [
        {
            "laneId": "native-v1.12.34-ort1.23.2-page-era",
            "executedRoot": "runtime-1.12.34-ad-hoc",
            "originalRoot": "runtime-1.12.34-original",
            "archiveName": "sherpa-onnx-v1.12.34-osx-arm64-shared.tar.bz2",
            "expectedArchiveSha256": (
                "65ed4f3784406163e505694c39acb507f5d4bd1b2b9e6cef23f00d3c4a81b40f"
            ),
            "onnxRuntimeLibrary": "libonnxruntime.1.23.2.dylib",
            "sherpaOnnxVersion": "1.12.34",
            "sherpaOnnxGitSha1": "12e81142",
            "onnxRuntimeVersion": "1.23.2",
            "measuredRuns": 5,
            "supportsHotwords": False,
        },
        {
            "laneId": "native-v1.13.4-ort1.27.0-current",
            "executedRoot": "runtime-ad-hoc",
            "originalRoot": "runtime",
            "archiveName": "sherpa-onnx-v1.13.4-osx-arm64-shared.tar.bz2",
            "expectedArchiveSha256": (
                "809ab5d0c77bd8f358364a244e6ab17f2afecf9779eb9fd436fa469c3ff5375c"
            ),
            "onnxRuntimeLibrary": "libonnxruntime.1.27.0.dylib",
            "sherpaOnnxVersion": "1.13.4",
            "sherpaOnnxGitSha1": "14280725",
            "onnxRuntimeVersion": "1.27.0",
            "measuredRuns": 5,
            "supportsHotwords": True,
        },
        {
            "laneId": "native-v1.13.4-ort1.24.4-diagnostic",
            "executedRoot": "runtime-1.13.4-ort1.24.4-ad-hoc",
            "originalRoot": "runtime-1.13.4-ort1.24.4-original",
            "archiveName": (
                "sherpa-onnx-v1.13.4-onnxruntime-1.24.4-osx-arm64-shared.tar.bz2"
            ),
            "expectedArchiveSha256": (
                "cb4198f8dee474d16e3ff98a4cd2448e3a9a10195a4809e13b738934beab4aad"
            ),
            "onnxRuntimeLibrary": "libonnxruntime.1.24.4.dylib",
            "sherpaOnnxVersion": "1.13.4",
            "sherpaOnnxGitSha1": "14280725",
            "onnxRuntimeVersion": "1.24.4",
            "measuredRuns": 3,
            "supportsHotwords": True,
        },
    ]
    native_provenance = _native_runtime_provenance(
        local_root, native_definitions
    )
    lanes: dict[str, dict[str, Any]] = {}
    for definition in native_definitions:
        lane_id = definition["laneId"]
        executable = (
            local_root
            / definition["executedRoot"]
            / "bin/sherpa-onnx-vad-with-offline-asr"
        )
        measured_runs = definition["measuredRuns"]
        supports_hotwords = definition["supportsHotwords"]
        observations = []
        for index in range(measured_runs + 1):
            warmup = index == 0
            observation = run_native_once(
                command=native_command(
                    executable=executable,
                    model_root=model_root,
                    silero_model=silero_model,
                    audio=audio,
                    threads=2,
                    supports_hotwords=supports_hotwords,
                ),
                output_root=local_root / "evidence" / lane_id,
                lane_id=lane_id,
                run_index=index,
                warmup=warmup,
                sampler_interval_seconds=0.02,
                execution_id=execution_id,
            )
            observations.append(observation)
            print(
                json.dumps(
                    {
                        "laneId": lane_id,
                        "runIndex": index,
                        "warmup": warmup,
                        "rtf": observation["rtf"],
                    },
                    sort_keys=True,
                    allow_nan=False,
                ),
                flush=True,
            )
        lanes[lane_id] = summarize_observations(observations)

    current_runtime = root / "build/desktop_asr_comparison/m4/runtime"
    current_tools = root / "build/desktop_asr_comparison/m4/tools-qwen3"
    current_worker = current_tools / "desktop_asr_candidate_worker"
    diagnostic_tools = local_root / "tools"
    dart_definitions = [
        (
            "dart-v1.13.4-ort1.27.0-fixed15-current-worker",
            current_tools,
            current_worker,
            "fixed-resource",
            "fixed_15_seconds",
            None,
            False,
        ),
        (
            "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker",
            diagnostic_tools,
            diagnostic_tools / "qwen3_official_rtf_diagnostic_worker",
            "diagnostic-fixed-15-seconds",
            "fixed_15_seconds",
            None,
            True,
        ),
        (
            "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker",
            diagnostic_tools,
            diagnostic_tools / "qwen3_official_rtf_diagnostic_worker",
            "diagnostic-official-silero-vad",
            "official_silero_vad",
            model_silero,
            True,
        ),
    ]
    dart_provenance = {
        "runtime": {
            "sherpaCApiSha256": sha256_file(
                current_runtime / "libsherpa-onnx-c-api.dylib"
            ),
            "onnxRuntimeSha256": sha256_file(
                current_runtime / "libonnxruntime.1.27.0.dylib"
            ),
        },
        "currentWorker": {
            "workerSha256": sha256_file(current_worker),
            "sandboxedLauncherSha256": sha256_file(
                current_tools / "sandboxed_candidate_launcher"
            ),
            "nativeProcessGroupLauncherSha256": sha256_file(
                current_tools / "native_process_group_launcher"
            ),
        },
        "diagnosticWorker": {
            "workerSha256": sha256_file(
                diagnostic_tools / "qwen3_official_rtf_diagnostic_worker"
            ),
            "workerSourceSha256": sha256_file(
                root / "apps/desktop/tool/qwen3_official_rtf_diagnostic_worker.dart"
            ),
            "sandboxedLauncherSha256": sha256_file(
                diagnostic_tools / "sandboxed_candidate_launcher"
            ),
            "nativeProcessGroupLauncherSha256": sha256_file(
                diagnostic_tools / "native_process_group_launcher"
            ),
        },
    }
    definitions_by_lane = {
        definition[0]: definition for definition in dart_definitions
    }

    def execute_dart_definition(
        definition: tuple[Any, ...],
        *,
        index: int,
        warmup: bool,
        schedule_order: int,
    ) -> dict[str, Any]:
        (
            lane_id,
            tool_root,
            worker,
            profile_id,
            segmentation,
            vad_model,
            is_diagnostic_worker,
        ) = definition
        observation = run_dart_once(
            repository_root=root,
            experiment=experiment,
            model_root=model_root,
            runtime_root=current_runtime,
            tool_root=tool_root,
            worker=worker,
            audio=audio,
            output_root=local_root / "evidence" / lane_id,
            lane_id=lane_id,
            profile_id=profile_id,
            run_index=index,
            warmup=warmup,
            segmentation=segmentation,
            silero_model=vad_model,
            execution_id=execution_id,
            diagnostic_worker=is_diagnostic_worker,
            schedule_order=schedule_order,
        )
        print(
            json.dumps(
                {
                    "laneId": lane_id,
                    "runIndex": index,
                    "warmup": warmup,
                    "scheduleOrder": schedule_order,
                    "rtf": observation["rtf"],
                },
                sort_keys=True,
                allow_nan=False,
            ),
            flush=True,
        )
        return observation

    current_lane = "dart-v1.13.4-ort1.27.0-fixed15-current-worker"
    current_observations = [
        execute_dart_definition(
            definitions_by_lane[current_lane],
            index=index,
            warmup=index == 0,
            schedule_order=index,
        )
        for index in range(6)
    ]
    lanes[current_lane] = summarize_observations(current_observations)

    diagnostic_fixed_lane = (
        "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker"
    )
    diagnostic_vad_lane = (
        "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker"
    )
    diagnostic_observations: dict[str, list[dict[str, Any]]] = {
        diagnostic_fixed_lane: [],
        diagnostic_vad_lane: [],
    }
    for schedule_order, lane_id in enumerate(
        (diagnostic_fixed_lane, diagnostic_vad_lane)
    ):
        diagnostic_observations[lane_id].append(
            execute_dart_definition(
                definitions_by_lane[lane_id],
                index=0,
                warmup=True,
                schedule_order=schedule_order,
            )
        )
    segmentation_schedule = diagnostic_segmentation_schedule(
        diagnostic_fixed_lane, diagnostic_vad_lane
    )
    measured_schedule = segmentation_schedule["measuredOrder"]
    measured_index = {diagnostic_fixed_lane: 0, diagnostic_vad_lane: 0}
    for schedule_order, lane_id in enumerate(measured_schedule, start=2):
        measured_index[lane_id] += 1
        diagnostic_observations[lane_id].append(
            execute_dart_definition(
                definitions_by_lane[lane_id],
                index=measured_index[lane_id],
                warmup=False,
                schedule_order=schedule_order,
            )
        )
    for lane_id, observations in diagnostic_observations.items():
        lanes[lane_id] = summarize_observations(observations)

    diagnostic_probes = _run_diagnostic_probes(
        local_root=local_root,
        model_root=model_root,
        silero_model=silero_model,
        audio=audio,
        execution_id=execution_id,
    )
    completed_at = utc_now()
    runner_sha256 = sha256_file(Path(__file__))
    model_hashes = {
        role: binding["sha256"]
        for role, binding in _model_files(
            experiment, model_root, silero_model=model_silero
        ).items()
    }
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "m4_qwen3_official_rtf_reproduction_local_bounded_evidence",
        "outcome": "COMPLETED",
        "execution": {
            "executionId": execution_id,
            "startedAt": started_at,
            "completedAt": completed_at,
            "freshRunRequired": True,
            "resumedRunCount": sum(
                int(observation.get("resumed", False))
                for lane in lanes.values()
                for observation in (
                    lane["warmupObservations"] + lane["observations"]
                )
            ),
        },
        "diagnosticSegmentationSchedule": segmentation_schedule,
        "runnerSha256": runner_sha256,
        "host": _host_metadata(),
        "officialBaseline": {
            "pageUrl": OFFICIAL_PAGE_URL,
            "audioUrl": OFFICIAL_AUDIO_URL,
            "audioDurationSeconds": 334.234,
            "elapsedSeconds": OFFICIAL_ELAPSED_SECONDS,
            "rtf": OFFICIAL_RTF,
            "hardware": "not_disclosed",
            "completeBuildFlags": "not_disclosed",
        },
        "strictControls": {
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
        "audio": {
            "sha256": sha256_file(audio),
            "durationSeconds": _wave_duration(audio),
            "licenseDisposition": (
                "ACCEPTED_LOCAL_ONLY_UPSTREAM_PUBLIC_EXAMPLE_"
                "NO_AUDIO_REDISTRIBUTION"
            ),
        },
        "provenance": {
            "nativeRuntimes": native_provenance,
            "dart": dart_provenance,
            "modelHashes": model_hashes,
            "audioSha256": sha256_file(audio),
            "sileroVadSha256": sha256_file(silero_model),
            "resourceSamplerSha256": sha256_file(
                comparison_root / "resource_sampler.py"
            ),
        },
        "lanes": lanes,
        "diagnosticProbes": diagnostic_probes,
        "privacy": {
            "audioPublished": False,
            "modelFilesPublished": False,
            "transcriptPublished": False,
            "absolutePathsPublished": False,
            "rawLogsLocalOnly": True,
        },
    }
    _atomic_json(local_root / "bounded_summary.json", document)
    return document


def _run_diagnostic_probes(
    *,
    local_root: Path,
    model_root: Path,
    silero_model: Path,
    audio: Path,
    execution_id: str,
) -> dict[str, Any]:
    executable = (
        local_root / "runtime-ad-hoc/bin/sherpa-onnx-vad-with-offline-asr"
    )
    thread_observations = []
    for threads in (4, 6, 8):
        observation = run_native_once(
            command=native_command(
                executable=executable,
                model_root=model_root,
                silero_model=silero_model,
                audio=audio,
                threads=threads,
            ),
            output_root=local_root / "evidence/thread-probes",
            lane_id=f"native-current-threads-{threads}",
            run_index=0,
            warmup=False,
            sampler_interval_seconds=0.02,
            execution_id=execution_id,
        )
        thread_observations.append(
            _publishable_observation({"threads": threads, **observation})
        )
    sampler_off = []
    for index in range(3):
        observation = run_native_once(
            command=native_command(
                executable=executable,
                model_root=model_root,
                silero_model=silero_model,
                audio=audio,
                threads=2,
            ),
            output_root=local_root / "evidence/sampler-off-probe",
            lane_id="native-current-sampler-off",
            run_index=index,
            warmup=index == 0,
            sampler_interval_seconds=None,
            execution_id=execution_id,
        )
        sampler_off.append(observation)
    return {
        "threadScalingCurrentOrt127": thread_observations,
        "samplerOffCurrentOrt127": summarize_observations(sampler_off),
    }


def _wave_duration(path: Path) -> float:
    import wave

    with wave.open(str(path), "rb") as source:
        require(source.getnchannels() == 1, "audio must be mono")
        require(source.getframerate() == 16000, "audio must be 16 kHz")
        require(source.getsampwidth() == 2, "audio must be signed 16-bit PCM")
        return source.getnframes() / source.getframerate()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
    )
    parser.add_argument(
        "--expected-audio-sha256",
        default="77b34b85923c7cb3e82670b8afc70b5d2dfce0477769c6bfa85d2722701c6d57",
    )
    args = parser.parse_args()
    try:
        document = execute(args)
    except (
        OSError,
        ValueError,
        json.JSONDecodeError,
        ReproductionError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Qwen3 official RTF reproduction: FAIL: {error}")
        return 1
    print(
        json.dumps(
            {
                "kind": document["kind"],
                "laneCount": len(document["lanes"]),
                "outcome": "PASS",
            },
            sort_keys=True,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
