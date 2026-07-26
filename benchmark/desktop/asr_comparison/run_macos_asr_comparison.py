#!/usr/bin/env python3
"""Deterministic, fail-closed orchestration for macOS ASR comparison v2."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Sequence

import psutil

try:
    from aggregate_results import aggregate_candidate
    from asr_scoring import ScoringError, score_text
    from resource_sampler import ProcessTreeSampler, ResourceSamplerError
except ModuleNotFoundError:
    from benchmark.desktop.asr_comparison.aggregate_results import aggregate_candidate
    from benchmark.desktop.asr_comparison.asr_scoring import ScoringError, score_text
    from benchmark.desktop.asr_comparison.resource_sampler import (
        ProcessTreeSampler,
        ResourceSamplerError,
    )


SCHEMA_VERSION = 2
MAX_LINE_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_EVENTS = 256
MAX_TOKEN_COUNT = 100_000
MAX_TIMESTAMP_COUNT = 100_000
MAX_DURATION_SECONDS = 14_400
SUCCESS_SEQUENCE = (
    "handshake",
    "effectiveConfig",
    "modelLoadComplete",
    "result",
    "unloadStart",
    "unloadComplete",
    "complete",
)


def _nearest_rank_percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        raise ValueError("percentile requires at least one value")
    if percentile <= 0 or percentile > 1:
        raise ValueError("percentile must be in (0, 1]")
    ordered = sorted(float(value) for value in values)
    return ordered[max(0, math.ceil(percentile * len(ordered)) - 1)]


class OrchestrationError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def deterministic_schedule(
    matrix: Sequence[dict[str, Any]],
    *,
    seed: int,
    warmup_runs: int,
    measured_runs: int,
) -> list[dict[str, Any]]:
    """Rotate candidate/profile order without changing the frozen matrix."""
    if not matrix:
        raise OrchestrationError("EMPTY_MATRIX", "comparison matrix is empty")
    if warmup_runs < 0 or measured_runs < 1:
        raise OrchestrationError("INVALID_SCHEDULE", "run counts are invalid")
    identities = [
        (
            str(item.get("candidateId", "")),
            str(item.get("profileId", "")),
            str(item.get("fixtureId", "")),
        )
        for item in matrix
    ]
    if any(not all(identity) for identity in identities) or len(set(identities)) != len(
        identities
    ):
        raise OrchestrationError(
            "INVALID_MATRIX", "matrix identities must be complete and unique"
        )
    base = sorted((dict(item) for item in matrix), key=lambda item: (
        item["candidateId"],
        item["profileId"],
        item["fixtureId"],
    ))
    scheduled: list[dict[str, Any]] = []
    order = 0
    total_rounds = warmup_runs + measured_runs
    for run_index in range(total_rounds):
        digest = hashlib.sha256(f"{seed}:{run_index}".encode()).digest()
        offset = int.from_bytes(digest[:8], "big") % len(base)
        rotated = base[offset:] + base[:offset]
        for item in rotated:
            scheduled.append(
                {
                    **item,
                    "runIndex": run_index,
                    "warmup": run_index < warmup_runs,
                    "scheduleOrder": order,
                }
            )
            order += 1
    return scheduled


def build_stage_plan(
    contract: dict[str, Any],
    registry: dict[str, Any],
    fixture_manifest: dict[str, Any],
    *,
    stage_id: str,
) -> dict[str, Any]:
    """Resolve the frozen stage matrix without authorizing U7/U8 execution."""
    stages = [
        stage for stage in contract.get("stages", []) if stage.get("stageId") == stage_id
    ]
    if len(stages) != 1:
        raise OrchestrationError("UNKNOWN_STAGE", f"unknown stage: {stage_id}")
    stage = stages[0]
    allowed_roles = set(stage.get("allowedFixtureRoles", []))
    fixtures = [
        fixture
        for fixture in fixture_manifest.get("fixtures", [])
        if fixture.get("fixtureRole") in allowed_roles
    ]
    candidates = registry.get("candidates")
    frozen = registry.get("frozenCandidateSet")
    if (
        not isinstance(candidates, list)
        or not isinstance(frozen, list)
        or [candidate.get("candidateId") for candidate in candidates] != frozen
    ):
        raise OrchestrationError(
            "REGISTRY_ORDER_MISMATCH", "candidate registry is not the frozen round"
        )
    entries: list[dict[str, Any]] = []
    candidate_blockers: list[dict[str, Any]] = []
    for candidate in candidates:
        candidate_id = candidate["candidateId"]
        profiles = candidate.get("profiles", {})
        eligible_profiles = [
            profile_id
            for profile_id, profile in profiles.items()
            if stage_id in profile.get("allowedStages", [])
        ]
        admission = candidate.get("admission", {})
        blockers = (
            [
                f"ADMISSION_{admission.get('status', 'MISSING')}",
                "LOCAL_MODEL_COMPONENTS_REQUIRED",
            ]
            if admission.get("status") != "ADMITTED"
            else []
        )
        if candidate.get("runtimeKind") == "native_funasr" and stage_id not in {
            "STAGE_0_ADMISSION",
            "STAGE_1_SHORT",
        }:
            blockers.append("NATIVE_CONTROL_SHORT_STAGE_ONLY")
        if blockers:
            candidate_blockers.append(
                {"candidateId": candidate_id, "blockers": sorted(set(blockers))}
            )
        lane_ids = candidate.get("runtimeLaneIds") or [
            "native-funasr-python-1.3.22-macos-arm64-control"
        ]
        for profile_id in eligible_profiles:
            profile = profiles[profile_id]
            for fixture in fixtures:
                entries.append(
                    {
                        "candidateId": candidate_id,
                        "runtimeKind": candidate["runtimeKind"],
                        "laneIds": lane_ids,
                        "profileId": profile_id,
                        "scorecard": profile["scorecard"],
                        "fixtureId": fixture["fixtureId"],
                        "fixtureRole": fixture["fixtureRole"],
                        "scenario": fixture["scenario"],
                        "rankEligible": (
                            candidate["runtimeKind"] == "sherpa_onnx"
                            and fixture["fixtureRole"] in {"development", "held_out"}
                        ),
                    }
                )
    execution_blockers = [
        "U7_U8_EXECUTION_NOT_AUTHORIZED_BY_U1_U6_TOOLING",
        *(
            ["DEVELOPMENT_OR_HELD_OUT_LOCAL_PACK_REQUIRED"]
            if any(
                fixture.get("distributionState") == "local_only"
                and fixture.get("freezeState") != "FROZEN"
                for fixture in fixtures
            )
            else []
        ),
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "contractId": contract.get("contractId"),
        "registryId": registry.get("registryId"),
        "fixtureManifestId": fixture_manifest.get("fixtureManifestId"),
        "stageId": stage_id,
        "purpose": stage.get("purpose"),
        "planOnly": True,
        "executionAuthorized": False,
        "allowedFixtureRoles": sorted(allowed_roles),
        "matrixEntries": entries,
        "candidateBlockers": candidate_blockers,
        "executionBlockers": execution_blockers,
    }


def binding_sha256(binding: dict[str, Any]) -> str:
    required = {
        "contractSha256",
        "candidateRegistrySha256",
        "scoringContractSha256",
        "scorerSha256",
        "runtimeSha256",
        "workerSha256",
        "fixtureSha256",
        "referenceSha256",
        "profileSha256",
    }
    if set(binding) != required:
        raise OrchestrationError(
            "INVALID_BINDING", f"binding keys must be exactly {sorted(required)}"
        )
    for key, value in binding.items():
        if (
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            raise OrchestrationError("INVALID_BINDING", f"{key} is not SHA-256")
    return sha256_bytes(canonical_json(binding))


def deterministic_run_id(specification: dict[str, Any], binding: dict[str, Any]) -> str:
    identity = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": specification["candidateId"],
        "laneId": specification["laneId"],
        "profileId": specification["profileId"],
        "fixtureId": specification["fixtureId"],
        "runIndex": specification["runIndex"],
        "warmup": specification["warmup"],
        "scorecard": specification["scorecard"],
        "bindingSha256": binding_sha256(binding),
    }
    return f"asr2-{sha256_bytes(canonical_json(identity))[:32]}"


def _atomic_json(destination: Path, value: Any) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(
            value,
            stream,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, destination)


def _quarantine(source: Path, quarantine_root: Path, reason: str) -> Path:
    quarantine_root.mkdir(parents=True, exist_ok=True)
    suffix = sha256_bytes(f"{source}:{time.time_ns()}".encode())[:12]
    destination = quarantine_root / f"{source.name}.{reason}.{suffix}"
    os.replace(source, destination)
    return destination


def _read_reusable_run(
    destination: Path,
    *,
    expected_binding_sha256: str,
    run_id: str,
    specification: dict[str, Any],
    raw_root: Path,
) -> dict[str, Any] | None:
    if not destination.exists():
        return None
    try:
        payload = json.loads(destination.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not (
        isinstance(payload, dict)
        and payload.get("schemaVersion") == SCHEMA_VERSION
        and payload.get("runId") == run_id
        and payload.get("complete") is True
        and payload.get("bindingSha256") == expected_binding_sha256
        and payload.get("disposition") == "SUCCESS"
        and payload.get("temporaryArtifactsReleased") is True
    ):
        return None
    for key in (
        "candidateId",
        "laneId",
        "profileId",
        "fixtureId",
        "scenario",
        "scorecard",
        "runIndex",
        "warmup",
        "scheduleOrder",
    ):
        if payload.get(key) != specification.get(key):
            return None
    if not _finite_json_numbers(payload.get("metrics")) or not _finite_json_numbers(
        payload.get("resources")
    ):
        return None
    raw_path = raw_root / f"{run_id}.json"
    try:
        raw_document = json.loads(raw_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        not isinstance(raw_document, dict)
        or raw_document.get("schemaVersion") != SCHEMA_VERSION
        or raw_document.get("runId") != run_id
        or not isinstance(raw_document.get("events"), list)
    ):
        return None
    results = [
        event
        for event in raw_document["events"]
        if isinstance(event, dict) and event.get("type") == "result"
    ]
    if len(results) != 1:
        return None
    result = results[0]
    output_hash = sha256_bytes(
        canonical_json(
            {
                "text": result.get("text"),
                "tokens": result.get("tokens"),
                "timestamps": result.get("timestamps"),
            }
        )
    )
    if payload.get("rawOutputSha256") != output_hash:
        return None
    try:
        duration_seconds = float(result["durationSeconds"])
        decode_milliseconds = float(result["decodeMilliseconds"])
        load_milliseconds = float(result["loadMilliseconds"])
        segment_wall_milliseconds = [
            float(value) for value in result["segmentWallMilliseconds"]
        ]
        if (
            duration_seconds <= 0
            or not math.isfinite(duration_seconds)
            or not math.isfinite(decode_milliseconds)
            or not math.isfinite(load_milliseconds)
            or not segment_wall_milliseconds
            or any(
                not math.isfinite(value) or value < 0
                for value in segment_wall_milliseconds
            )
        ):
            return None
        scoring = score_text(
            str(specification["reference"]),
            str(result["text"]),
            duration_seconds=duration_seconds,
            annotations=specification.get("annotations"),
        )
        lexical = scoring["lexical"]
        expected_metrics = {
            "cer": lexical["cer"],
            "wer": lexical["wer"],
            "terminologyRecall": lexical["terminologyRecall"],
            "numericEventAccuracy": lexical["numericEventAccuracy"],
            "hallucinationLexicalCharactersPerMinute": scoring["nonSpeech"][
                "hallucinationLexicalCharactersPerMinute"
            ],
            "rtf": decode_milliseconds / (duration_seconds * 1000),
            "loadMilliseconds": load_milliseconds,
            "decodeMilliseconds": decode_milliseconds,
            "segmentLatencyP50Milliseconds": _nearest_rank_percentile(
                segment_wall_milliseconds, 0.5
            ),
            "segmentLatencyP95Milliseconds": _nearest_rank_percentile(
                segment_wall_milliseconds, 0.95
            ),
        }
    except (KeyError, TypeError, ValueError, ScoringError):
        return None
    metrics = payload["metrics"]
    if any(metrics.get(key) != value for key, value in expected_metrics.items()):
        return None
    for key in ("endToEndWallMilliseconds", "processWallMilliseconds"):
        value = metrics.get(key)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
        ):
            return None
    return payload


def _finite_json_numbers(value: Any) -> bool:
    if isinstance(value, dict):
        return all(_finite_json_numbers(child) for child in value.values())
    if isinstance(value, list):
        return all(_finite_json_numbers(child) for child in value)
    if isinstance(value, float):
        return math.isfinite(value)
    return value is None or isinstance(value, (str, bool, int))


def _minimal_environment(temporary_root: Path) -> dict[str, str]:
    user_home = os.environ.get("HOME")
    if not user_home or not Path(user_home).is_absolute():
        raise OrchestrationError(
            "SANDBOX_PROBE_UNAVAILABLE",
            "an absolute HOME is required by the active user-home denial probe",
        )
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": str(temporary_root),
        # The launcher needs the real home path only to prove that its sandbox
        # denies access to it. The launcher replaces the environment before it
        # starts the candidate worker, so HOME never reaches model execution.
        "HOME": user_home,
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "MODELSCOPE_OFFLINE": "1",
    }


def _consume_stderr(
    stream: Any, output: bytearray, limit: int = 64 * 1024
) -> None:
    while True:
        chunk = stream.buffer.read(4096)
        if not chunk:
            return
        remaining = limit - len(output)
        if remaining > 0:
            output.extend(chunk[:remaining])


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_process_group(
    process: subprocess.Popen[str], *, grace_seconds: float = 0.25
) -> dict[str, Any]:
    term_sent = False
    kill_sent = False
    try:
        descendants = psutil.Process(process.pid).children(recursive=True)
    except psutil.NoSuchProcess:
        descendants = []
    if _process_group_exists(process.pid):
        try:
            os.killpg(process.pid, signal.SIGTERM)
            term_sent = True
        except (ProcessLookupError, PermissionError):
            pass
    for descendant in descendants:
        try:
            descendant.terminate()
            term_sent = True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline and (
        _process_group_exists(process.pid)
        or any(descendant.is_running() for descendant in descendants)
    ):
        time.sleep(0.01)
    if _process_group_exists(process.pid):
        try:
            os.killpg(process.pid, signal.SIGKILL)
            kill_sent = True
        except (ProcessLookupError, PermissionError):
            pass
    for descendant in descendants:
        try:
            if descendant.is_running():
                descendant.kill()
                kill_sent = True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and (
        _process_group_exists(process.pid)
        or any(descendant.is_running() for descendant in descendants)
    ):
        time.sleep(0.01)
    descendants_gone = all(
        not descendant.is_running()
        for descendant in descendants
    )
    return {
        "termSent": term_sent,
        "killSent": kill_sent,
        "processGroupGone": not _process_group_exists(process.pid),
        "observedDescendantCount": len(descendants),
        "descendantProcessesGone": descendants_gone,
    }


def _validate_event(
    event: Any,
    *,
    specification: dict[str, Any],
    observed_types: list[str],
) -> None:
    if not isinstance(event, dict) or event.get("schemaVersion") != SCHEMA_VERSION:
        raise OrchestrationError("MALFORMED_OUTPUT", "worker event schema is invalid")
    event_type = event.get("type")
    if not isinstance(event_type, str):
        raise OrchestrationError("MALFORMED_OUTPUT", "worker event type is missing")
    if event.get("candidateId") != specification["candidateId"]:
        raise OrchestrationError("IDENTITY_MISMATCH", "worker candidate identity changed")
    for key in ("profileId", "sourceSha256"):
        if key in event and event[key] != specification[key]:
            raise OrchestrationError("IDENTITY_MISMATCH", f"worker {key} changed")
    if event_type == "error":
        code = event.get("code")
        message = event.get("message")
        if (
            not isinstance(code, str)
            or code
            not in {
                "INVALID_REQUEST_OR_IDENTITY",
                "DECODE_FAILED",
                "WORKER_FAILED",
            }
            or not isinstance(message, str)
            or len(message.encode()) > 1024
        ):
            raise OrchestrationError(
                "MALFORMED_OUTPUT", "worker error event is invalid"
            )
        raise OrchestrationError(code, f"candidate worker reported {message}")
    if event_type == "handshake":
        process_id = event.get("processId")
        if (
            not isinstance(process_id, int)
            or isinstance(process_id, bool)
            or process_id <= 0
        ):
            raise OrchestrationError(
                "MALFORMED_OUTPUT", "worker process identity is invalid"
            )
        if event.get("runtimeBindingState") != "not_initialized":
            raise OrchestrationError(
                "BASELINE_CONTAMINATED",
                "worker initialized runtime bindings before the baseline freeze",
            )
    if event_type == "result":
        text = event.get("text")
        tokens = event.get("tokens")
        timestamps = event.get("timestamps")
        if (
            not isinstance(text, str)
            or len(text.encode()) > MAX_OUTPUT_BYTES
            or not isinstance(tokens, list)
            or len(tokens) > MAX_TOKEN_COUNT
            or not isinstance(timestamps, list)
            or len(timestamps) > MAX_TIMESTAMP_COUNT
        ):
            raise OrchestrationError(
                "OUTPUT_BOUND", "worker result exceeds observation bounds"
            )
        previous_timestamp = 0.0
        for timestamp in timestamps:
            if (
                not isinstance(timestamp, (int, float))
                or isinstance(timestamp, bool)
                or not math.isfinite(timestamp)
                or timestamp < previous_timestamp
            ):
                raise OrchestrationError(
                    "MALFORMED_OUTPUT", "worker timestamps must be finite and monotonic"
                )
            previous_timestamp = float(timestamp)
        for key in ("durationSeconds", "loadMilliseconds", "decodeMilliseconds"):
            value = event.get(key)
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value < 0
            ):
                raise OrchestrationError(
                    "MALFORMED_OUTPUT", f"worker {key} must be finite"
                )
        segment_wall_milliseconds = event.get("segmentWallMilliseconds")
        segment_count = event.get("segmentCount")
        if (
            not isinstance(segment_count, int)
            or isinstance(segment_count, bool)
            or segment_count <= 0
            or not isinstance(segment_wall_milliseconds, list)
            or len(segment_wall_milliseconds) != segment_count
            or any(
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value < 0
                for value in segment_wall_milliseconds
            )
        ):
            raise OrchestrationError(
                "MALFORMED_OUTPUT",
                "worker segment timings must be finite and match segmentCount",
            )
        if event["durationSeconds"] <= 0 or event["durationSeconds"] > MAX_DURATION_SECONDS:
            raise OrchestrationError(
                "INVALID_DURATION", "worker duration is outside the contract envelope"
            )
    if event_type == "partial":
        if "modelLoadComplete" not in observed_types or "result" in observed_types:
            raise OrchestrationError(
                "EVENT_ORDER", "partial event is outside the decode boundary"
            )
        for key in ("audioSeconds", "wallMilliseconds"):
            value = event.get(key)
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value < 0
            ):
                raise OrchestrationError(
                    "MALFORMED_OUTPUT", f"partial {key} must be finite"
                )
        return
    if event_type == "unloadComplete":
        resident_bytes = event.get("residentBytes")
        if (
            not isinstance(resident_bytes, int)
            or isinstance(resident_bytes, bool)
            or resident_bytes < 0
        ):
            raise OrchestrationError(
                "MALFORMED_OUTPUT",
                "worker unload resident bytes must be a non-negative integer",
            )
    expected_index = len([value for value in observed_types if value != "partial"])
    if expected_index >= len(SUCCESS_SEQUENCE) or event_type != SUCCESS_SEQUENCE[
        expected_index
    ]:
        raise OrchestrationError(
            "EVENT_ORDER",
            f"expected {SUCCESS_SEQUENCE[expected_index] if expected_index < len(SUCCESS_SEQUENCE) else 'end'}, got {event_type}",
        )


def execute_run(
    *,
    command: Sequence[str],
    request: dict[str, Any],
    specification: dict[str, Any],
    binding: dict[str, Any],
    run_root: Path,
    raw_root: Path,
    timeout_seconds: float,
    sampler_interval_seconds: float,
) -> dict[str, Any]:
    """Execute a single fresh worker process and atomically preserve its run."""
    if timeout_seconds <= 0 or timeout_seconds > 86_400:
        raise OrchestrationError("INVALID_TIMEOUT", "timeout is out of bounds")
    expected_binding_sha256 = binding_sha256(binding)
    run_id = deterministic_run_id(specification, binding)
    destination = run_root / f"{run_id}.json"
    quarantine_root = run_root / "quarantine"
    staging = run_root / ".staging" / f"{run_id}.json"
    reusable = _read_reusable_run(
        destination,
        expected_binding_sha256=expected_binding_sha256,
        run_id=run_id,
        specification=specification,
        raw_root=raw_root,
    )
    if reusable is not None:
        return {**reusable, "resumed": True}
    if destination.exists():
        _quarantine(destination, quarantine_root, "binding-or-integrity-mismatch")
    if staging.exists():
        _quarantine(staging, quarantine_root, "partial")
    run_root.mkdir(parents=True, exist_ok=True)
    raw_root.mkdir(parents=True, exist_ok=True)
    temporary_parent = run_root.parent / "temporary"
    temporary_parent.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f"{run_id}-", dir=temporary_parent)
    )
    _atomic_json(
        staging,
        {
            "schemaVersion": SCHEMA_VERSION,
            "runId": run_id,
            "complete": False,
            "bindingSha256": expected_binding_sha256,
        },
    )
    started_wall = time.time()
    started = time.monotonic()
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        env=_minimal_environment(temporary_root),
        bufsize=1,
    )
    sampler = ProcessTreeSampler(
        process.pid,
        interval_seconds=sampler_interval_seconds,
        temporary_root=temporary_root,
    )
    sampler.start()
    stderr_output = bytearray()
    assert process.stderr is not None
    stderr_thread = threading.Thread(
        target=_consume_stderr, args=(process.stderr, stderr_output), daemon=True
    )
    stderr_thread.start()
    events: list[dict[str, Any]] = []
    observed_types: list[str] = []
    timestamps: dict[str, float | None] = {
        "spawn": started_wall,
        "runtimeBinding": None,
        "modelLoad": None,
        "firstInput": None,
        "firstPartial": None,
        "firstFinal": None,
        "completion": None,
        "teardown": None,
    }
    monotonic_marks: dict[str, float | None] = {
        "spawn": started,
        "firstInput": None,
        "firstPartial": None,
        "firstFinal": None,
        "completion": None,
    }
    failure: OrchestrationError | None = None
    termination: dict[str, Any] | None = None
    try:
        if process.stdin is None or process.stdout is None:
            raise OrchestrationError("PIPE_UNAVAILABLE", "worker pipe unavailable")
        encoded_request = canonical_json(request)
        if len(encoded_request) > MAX_LINE_BYTES:
            raise OrchestrationError("INPUT_BOUND", "worker request exceeds line bound")
        process.stdin.write(encoded_request.decode() + "\n")
        process.stdin.flush()
        timestamps["firstInput"] = time.time()
        monotonic_marks["firstInput"] = time.monotonic()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = started + timeout_seconds
        output_bytes = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OrchestrationError("TIMEOUT", "worker exceeded run timeout")
            ready = selector.select(timeout=min(0.05, remaining))
            if not ready:
                if process.poll() is not None:
                    line = process.stdout.readline()
                    if not line:
                        break
                else:
                    continue
            else:
                line = process.stdout.readline()
                if not line:
                    if process.poll() is not None:
                        break
                    continue
            output_bytes += len(line.encode())
            if len(line.encode()) > MAX_LINE_BYTES or output_bytes > MAX_OUTPUT_BYTES:
                raise OrchestrationError(
                    "OUTPUT_BOUND", "worker JSONL output exceeds contract bound"
                )
            if len(events) >= MAX_EVENTS:
                raise OrchestrationError(
                    "OUTPUT_BOUND", "worker event count exceeds contract bound"
                )
            try:
                event = json.loads(line)
            except json.JSONDecodeError as error:
                raise OrchestrationError(
                    "MALFORMED_OUTPUT", "worker emitted malformed JSONL"
                ) from error
            _validate_event(
                event, specification=specification, observed_types=observed_types
            )
            event_type = event["type"]
            observed_types.append(event_type)
            events.append(event)
            if event_type == "handshake":
                try:
                    sampler.track_process(int(event["processId"]))
                except ResourceSamplerError as error:
                    raise OrchestrationError(
                        "MALFORMED_OUTPUT",
                        "worker process identity disappeared at handshake",
                    ) from error
                sampler.freeze_baseline()
                acknowledgement = {
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "baselineFrozen",
                    "candidateId": specification["candidateId"],
                    "profileId": specification["profileId"],
                    "sourceSha256": specification["sourceSha256"],
                }
                process.stdin.write(canonical_json(acknowledgement).decode() + "\n")
                process.stdin.close()
                timestamps["runtimeBinding"] = time.time()
            elif event_type == "modelLoadComplete":
                timestamps["modelLoad"] = time.time()
            elif event_type == "partial" and timestamps["firstPartial"] is None:
                timestamps["firstPartial"] = time.time()
                monotonic_marks["firstPartial"] = time.monotonic()
            elif event_type == "result":
                timestamps["firstFinal"] = time.time()
                monotonic_marks["firstFinal"] = time.monotonic()
            elif event_type == "unloadComplete":
                sampler.mark_unload_complete(
                    worker_reported_rss_bytes=int(event["residentBytes"])
                )
            elif event_type == "complete":
                timestamps["completion"] = time.time()
                monotonic_marks["completion"] = time.monotonic()
                break
        exit_code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if exit_code != 0:
            code = {
                65: "INVALID_INPUT",
                137: "OOM",
                -signal.SIGKILL: "OOM",
            }.get(exit_code, "CRASH")
            raise OrchestrationError(
                code, f"worker exited with status {exit_code}"
            )
        if tuple(value for value in observed_types if value != "partial") != SUCCESS_SEQUENCE:
            raise OrchestrationError(
                "INCOMPLETE_OUTPUT", "worker did not complete the event protocol"
            )
    except subprocess.TimeoutExpired as error:
        failure = OrchestrationError("TIMEOUT", "worker exceeded run timeout")
        termination = terminate_process_group(process)
        raise failure from error
    except BrokenPipeError as error:
        failure = OrchestrationError(
            "CRASH", "worker exited before accepting the request"
        )
        termination = terminate_process_group(process)
        raise failure from error
    except OrchestrationError as error:
        failure = error
        termination = terminate_process_group(process)
        raise
    finally:
        if process.poll() is None:
            termination = terminate_process_group(process)
        timestamps["teardown"] = time.time()
        resources = sampler.stop()
        stderr_thread.join(timeout=1)
        process.stdin and process.stdin.close()
        process.stdout and process.stdout.close()
        process.stderr and process.stderr.close()
        if failure is not None:
            raw_root.mkdir(parents=True, exist_ok=True)
            (raw_root / f"{run_id}.stderr.log").write_bytes(
                bytes(stderr_output)
            )
            disposition = {
                "schemaVersion": SCHEMA_VERSION,
                "runId": run_id,
                "complete": False,
                "disposition": failure.code,
                "bindingSha256": expected_binding_sha256,
                "termination": termination,
                "temporaryArtifactsReleased": False,
                "diagnosticSha256": sha256_bytes(bytes(stderr_output)),
            }
            _atomic_json(staging, disposition)
        shutil.rmtree(temporary_root, ignore_errors=True)
        if failure is not None:
            disposition["temporaryArtifactsReleased"] = not temporary_root.exists()
            _atomic_json(staging, disposition)

    result_event = next(event for event in events if event["type"] == "result")
    hypothesis = str(result_event["text"])
    reference = str(specification["reference"])
    duration_seconds = float(result_event["durationSeconds"])
    scoring = score_text(
        reference,
        hypothesis,
        duration_seconds=duration_seconds,
        annotations=specification.get("annotations"),
    )
    decode_milliseconds = float(result_event["decodeMilliseconds"])
    if duration_seconds <= 0:
        raise OrchestrationError("INVALID_DURATION", "decoded duration must be positive")
    raw_document = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "events": events,
        "stderrSha256": sha256_bytes(bytes(stderr_output)),
    }
    raw_hash = sha256_bytes(
        canonical_json(
            {
                "text": result_event.get("text"),
                "tokens": result_event.get("tokens"),
                "timestamps": result_event.get("timestamps"),
            }
        )
    )
    raw_destination = raw_root / f"{run_id}.json"
    _atomic_json(raw_destination, raw_document)
    lexical = scoring["lexical"]
    first_input_mark = monotonic_marks["firstInput"]
    first_final_mark = monotonic_marks["firstFinal"]
    completion_mark = monotonic_marks["completion"]
    if first_input_mark is None or first_final_mark is None or completion_mark is None:
        raise OrchestrationError(
            "INCOMPLETE_OUTPUT", "worker timing boundaries are incomplete"
        )
    end_to_end_wall_milliseconds = (
        first_final_mark - first_input_mark
    ) * 1000
    process_wall_milliseconds = (completion_mark - started) * 1000
    segment_wall_milliseconds = [
        float(value) for value in result_event["segmentWallMilliseconds"]
    ]
    metrics = {
        "cer": lexical["cer"],
        "wer": lexical["wer"],
        "terminologyRecall": lexical["terminologyRecall"],
        "numericEventAccuracy": lexical["numericEventAccuracy"],
        "hallucinationLexicalCharactersPerMinute": scoring["nonSpeech"][
            "hallucinationLexicalCharactersPerMinute"
        ],
        "rtf": decode_milliseconds / (duration_seconds * 1000),
        "loadMilliseconds": float(result_event["loadMilliseconds"]),
        "decodeMilliseconds": decode_milliseconds,
        "endToEndWallMilliseconds": end_to_end_wall_milliseconds,
        "processWallMilliseconds": process_wall_milliseconds,
        "segmentLatencyP50Milliseconds": _nearest_rank_percentile(
            segment_wall_milliseconds, 0.5
        ),
        "segmentLatencyP95Milliseconds": _nearest_rank_percentile(
            segment_wall_milliseconds, 0.95
        ),
        "absolutePeakRssBytes": resources["absolutePeakRssBytes"],
        "incrementalPeakRssBytes": resources["incrementalPeakRssBytes"],
        "retainedRssBytesAfterUnload": resources["retainedRssBytesAfterUnload"],
    }
    live_elapsed_milliseconds = result_event.get("liveElapsedMilliseconds")
    if live_elapsed_milliseconds is not None:
        metrics["liveElapsedMilliseconds"] = float(live_elapsed_milliseconds)
    streaming_final_wall_milliseconds = (
        float(live_elapsed_milliseconds)
        if live_elapsed_milliseconds is not None
        else decode_milliseconds
    )
    streaming_supported = bool(
        request.get("capabilities", {}).get("streaming", False)
    )
    paced_streaming = (
        streaming_supported
        and specification.get("pacingPolicy") == "realtime_audio_clock"
    )
    first_partial_wall_milliseconds = next(
        (
            float(event["wallMilliseconds"])
            for event in events
            if event["type"] == "partial"
        ),
        None,
    )
    record = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "complete": True,
        "disposition": "SUCCESS",
        "rankEligible": bool(specification.get("rankEligible", True)),
        "observationSource": specification.get("observationSource", "candidate_worker"),
        "candidateId": specification["candidateId"],
        "laneId": specification["laneId"],
        "profileId": specification["profileId"],
        "fixtureId": specification["fixtureId"],
        "scenario": specification["scenario"],
        "scorecard": specification["scorecard"],
        "runIndex": specification["runIndex"],
        "warmup": specification["warmup"],
        "scheduleOrder": specification["scheduleOrder"],
        "bindingSha256": expected_binding_sha256,
        "bindings": binding,
        "rawOutputSha256": raw_hash,
        "metrics": metrics,
        "resources": resources,
        "timestamps": timestamps,
        "streamingObservation": {
            "applicability": (
                "supported" if streaming_supported else "not_applicable"
            ),
            "partialCount": sum(event["type"] == "partial" for event in events),
            "firstPartialAudioSeconds": next(
                (
                    float(event["audioSeconds"])
                    for event in events
                    if event["type"] == "partial"
                ),
                None,
            ),
            "firstPartialWallMilliseconds": first_partial_wall_milliseconds,
            "firstPartialStatus": (
                "observed"
                if first_partial_wall_milliseconds is not None
                else "not_observed"
                if streaming_supported
                else "unsupported"
            ),
            "finalAudioSeconds": duration_seconds,
            "finalWallMilliseconds": (
                streaming_final_wall_milliseconds
                if streaming_supported
                else None
            ),
            "firstFinalWallMilliseconds": (
                streaming_final_wall_milliseconds
                if streaming_supported
                else None
            ),
            "firstFinalStatus": (
                "observed" if streaming_supported else "unsupported"
            ),
            "endpointLatencyMilliseconds": (
                max(
                    0.0,
                    streaming_final_wall_milliseconds - duration_seconds * 1000,
                )
                if paced_streaming
                else None
            ),
            "tailLatencyMilliseconds": (
                max(
                    0.0,
                    streaming_final_wall_milliseconds - duration_seconds * 1000,
                )
                if paced_streaming
                else None
            ),
            "tailLatencyStatus": (
                "observed"
                if paced_streaming
                else "not_collected_fixed_resource"
                if streaming_supported
                else "unsupported"
            ),
            "droppedChunkCount": int(result_event.get("droppedChunkCount", 0)),
            "maximumQueuedChunkCount": int(
                result_event.get("maximumQueuedChunkCount", 0)
            ),
            "pacingPolicy": specification.get("pacingPolicy", "unpaced"),
        },
        "temporaryArtifactsReleased": not temporary_root.exists(),
        "resumed": False,
    }
    _atomic_json(destination, record)
    staging.unlink(missing_ok=True)
    return record


def native_control_observation_envelope(
    *,
    candidate_id: str,
    fixture_id: str,
    profile_id: str,
    raw_output_sha256: str,
    metrics: dict[str, Any],
) -> dict[str, Any]:
    """Create the common envelope without admitting native FunASR to a sherpa lane."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": candidate_id,
        "laneId": "native-funasr-python-1.3.22-macos-arm64-control",
        "profileId": profile_id,
        "fixtureId": fixture_id,
        "scorecard": "end_to_end",
        "rankEligible": False,
        "crossRuntimeControl": True,
        "allowedStages": ["STAGE_0_ADMISSION", "STAGE_1_SHORT"],
        "rawOutputSha256": raw_output_sha256,
        "metrics": metrics,
    }


def _fake_smoke(root: Path, timeout_seconds: float) -> dict[str, Any]:
    comparison_root = root / "benchmark/desktop/asr_comparison"
    contract = json.loads((comparison_root / "macos_contract.json").read_text())
    fixture_manifest = json.loads((comparison_root / "fixtures.json").read_text())
    fixture = next(
        value
        for value in fixture_manifest["fixtures"]
        if value["fixtureId"] == "committed-zh-300s"
    )
    prepared_root = root / "build/desktop_asr_comparison/fixtures/active/fixtures"
    audio = prepared_root / "committed-zh-300s.wav"
    reference_path = prepared_root / "committed-zh-300s.txt"
    if sha256_file(audio) != fixture["audio"]["sha256"]:
        raise OrchestrationError("MISSING_FIXTURE", "prepared smoke audio is absent")
    if sha256_file(reference_path) != fixture["reference"]["sha256"]:
        raise OrchestrationError("MISSING_FIXTURE", "prepared reference is absent")
    reference = reference_path.read_text(encoding="utf-8")
    worker = comparison_root / "test_support/fake_candidate_worker.py"
    profile = {
        "modelFamily": "fake_contract_smoke",
        "provider": "cpu",
        "numThreads": 2,
        "concurrency": 1,
        "inputMode": "frozen_segments",
        "segmentDurationSeconds": 15,
        "pacingPolicy": "unpaced",
    }
    item = {
        "candidateId": "fake-contract-smoke",
        "profileId": "fixed-resource",
        "fixtureId": fixture["fixtureId"],
        "laneId": "fake-worker-non-ranked",
        "scorecard": "core_asr",
        "scenario": fixture["scenario"],
        "reference": reference,
        "rankEligible": False,
        "observationSource": "fake_worker_contract_smoke",
        "pacingPolicy": "unpaced",
    }
    schedule = deterministic_schedule(
        [item],
        seed=int(contract["scheduling"]["seed"]),
        warmup_runs=int(contract["scheduling"]["shortWarmupRuns"]),
        measured_runs=int(contract["scheduling"]["shortMeasuredRuns"]),
    )
    hashes = {
        "contractSha256": sha256_file(comparison_root / "macos_contract.json"),
        "candidateRegistrySha256": sha256_file(comparison_root / "candidates.json"),
        "scoringContractSha256": sha256_file(
            comparison_root / "scoring_contract.json"
        ),
        "scorerSha256": sha256_file(comparison_root / "asr_scoring.py"),
        "runtimeSha256": sha256_file(Path(sys.executable)),
        "workerSha256": sha256_file(worker),
        "fixtureSha256": sha256_file(audio),
        "referenceSha256": sha256_file(reference_path),
        "profileSha256": sha256_bytes(canonical_json(profile)),
    }
    command = [sys.executable, str(worker), "--mode", "success"]
    request = {
        "candidateId": item["candidateId"],
        "profileId": item["profileId"],
        "sourcePath": str(audio),
        "sourceSha256": hashes["fixtureSha256"],
        "durationSeconds": fixture["audio"]["durationSeconds"],
        "hypothesis": reference,
        "effectiveConfig": profile,
        "capabilities": {
            "streaming": False,
            "timestamps": False,
            "partialResults": False,
        },
    }
    run_root = root / contract["evidencePolicy"]["runRoot"]
    raw_root = root / contract["evidencePolicy"]["rawRoot"]
    runs = [
        execute_run(
            command=command,
            request=request,
            specification={**scheduled_item, "sourceSha256": hashes["fixtureSha256"]},
            binding=hashes,
            run_root=run_root,
            raw_root=raw_root,
            timeout_seconds=timeout_seconds,
            sampler_interval_seconds=0.02,
        )
        for scheduled_item in schedule
    ]
    aggregate = aggregate_candidate(runs)
    aggregate.update(
        {
            "rankEligible": False,
            "observationSource": "fake_worker_contract_smoke",
            "purpose": "orchestrator_scorer_aggregator_vertical_validation",
        }
    )
    destination = (
        root
        / "build/desktop_asr_comparison/aggregates/fake-contract-smoke.json"
    )
    _atomic_json(destination, aggregate)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "runCount": len(runs),
        "measuredRunCount": aggregate["measuredRunCount"],
        "aggregate": str(destination.relative_to(root)),
        "rankEligible": False,
        "allComplete": all(run["complete"] for run in runs),
        "resumedRunCount": sum(bool(run["resumed"]) for run in runs),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--fake-smoke", action="store_true")
    parser.add_argument(
        "--plan-stage",
        choices=[
            "STAGE_0_ADMISSION",
            "STAGE_1_SHORT",
            "STAGE_2_HELD_OUT",
            "STAGE_3_FINALIST",
        ],
    )
    parser.add_argument("--timeout-seconds", type=float, default=10)
    args = parser.parse_args()
    if args.fake_smoke == (args.plan_stage is not None):
        parser.error(
            "choose exactly one of --fake-smoke or --plan-stage"
        )
    root = args.root.resolve()
    if args.fake_smoke:
        result = _fake_smoke(root, args.timeout_seconds)
    else:
        comparison_root = root / "benchmark/desktop/asr_comparison"
        result = build_stage_plan(
            json.loads((comparison_root / "macos_contract.json").read_text()),
            json.loads((comparison_root / "candidates.json").read_text()),
            json.loads((comparison_root / "fixtures.json").read_text()),
            stage_id=args.plan_stage,
        )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
