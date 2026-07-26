#!/usr/bin/env python3
"""Validate and derive the fail-closed S3 speaker-admission result."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.speaker_diarization_contract import (
    DEFAULT_CONTRACT,
    PASS_STATUS,
    ManifestError,
    deferred_status as _deferred_status,
    is_sha256 as _is_sha256,
    require as _require,
    validate_deferred_evidence_summary,
    validate_manifest,
)


def _parse_rttm(text: str) -> list[tuple[str, float, float]]:
    turns: list[tuple[str, float, float]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        _require(len(fields) >= 8 and fields[0] == "SPEAKER", "invalid RTTM row")
        start = float(fields[3])
        duration = float(fields[4])
        _require(start >= 0 and duration > 0, "invalid RTTM bounds")
        turns.append((fields[7], start, start + duration))
    _require(bool(turns), "RTTM contains no annotated turns")
    return turns


def _paint_frames(
    turns: list[tuple[Any, float, float]],
    duration: float,
    step: float = 0.02,
) -> list[set[Any]]:
    frame_count = max(1, math.ceil(duration / step))
    frames = [set() for _ in range(frame_count)]
    for label, start, end in turns:
        _require(start >= 0 and end > start and end <= duration + step, "turn out of bounds")
        first = max(0, math.floor(start / step))
        last = min(frame_count, math.ceil(end / step))
        for index in range(first, last):
            frames[index].add(label)
    return frames


def _best_der(
    reference_frames: list[set[str]],
    hypothesis_frames: list[set[Any]],
) -> float:
    reference_speakers = sorted(set().union(*reference_frames))
    hypothesis_speakers = sorted(set().union(*hypothesis_frames))
    denominator = sum(len(frame) for frame in reference_frames)
    _require(denominator > 0, "reference contains no annotated speech")
    if not hypothesis_speakers:
        return 1.0
    mappings: list[dict[Any, str]] = []
    if len(hypothesis_speakers) >= len(reference_speakers):
        for selected in itertools.permutations(
            hypothesis_speakers,
            len(reference_speakers),
        ):
            mappings.append(
                {
                    hypothesis: reference_speakers[index]
                    for index, hypothesis in enumerate(selected)
                }
            )
    else:
        for selected in itertools.permutations(
            reference_speakers,
            len(hypothesis_speakers),
        ):
            mappings.append(
                {
                    hypothesis_speakers[index]: reference
                    for index, reference in enumerate(selected)
                }
            )
    best_error = math.inf
    for mapping in mappings:
        error = 0
        for reference, hypothesis in zip(reference_frames, hypothesis_frames):
            mapped = {
                mapping.get(label, f"unmapped:{label}")
                for label in hypothesis
            }
            error += max(len(reference), len(mapped)) - len(reference & mapped)
        best_error = min(best_error, error)
    return best_error / denominator


def _require_exact_keys(
    value: dict[str, Any],
    allowed: set[str],
    label: str,
) -> None:
    unknown = set(value) - allowed
    _require(not unknown, f"{label} contains unknown fields: {sorted(unknown)}")


def _reject_unsafe_evidence_payload(value: Any, *, location: str) -> None:
    forbidden_keys = {
        "absolutePath",
        "audio",
        "audioPayload",
        "embedding",
        "embeddings",
        "path",
        "pcm",
        "pcmPayload",
    }
    absolute_path = re.compile(r"^(?:/|[A-Za-z]:[\\/])")
    if isinstance(value, dict):
        for key, child in value.items():
            _require(
                key not in forbidden_keys,
                f"{location} contains forbidden evidence field: {key}",
            )
            _reject_unsafe_evidence_payload(child, location=f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_unsafe_evidence_payload(
                child,
                location=f"{location}[{index}]",
            )
    elif isinstance(value, str):
        _require(
            absolute_path.match(value) is None,
            f"{location} contains an absolute path",
        )


def _validate_evidence_identity(
    evidence: dict[str, Any],
    *,
    probe: str,
    manifest: dict[str, Any],
    contract: dict[str, Any],
) -> None:
    _require(evidence.get("schemaVersion") == 2, f"{probe} schemaVersion must be 2")
    _require(
        evidence.get("source") == "physical_android_instrumentation",
        f"{probe} evidence must come from physical Android instrumentation",
    )
    _require(evidence.get("probe") == probe, f"{probe} probe identity mismatch")
    _require(evidence.get("complete") is True, f"{probe} evidence is incomplete")
    _require(
        evidence.get("contractId") == contract.get("contractId"),
        f"{probe} contractId mismatch",
    )
    _require(
        evidence.get("contractSha256") == manifest.get("contractSha256"),
        f"{probe} contract SHA-256 mismatch",
    )
    _require(
        evidence.get("candidateId") == (contract.get("candidate") or {}).get("id"),
        f"{probe} candidateId mismatch",
    )
    configuration = evidence.get("configuration")
    _require(isinstance(configuration, dict), f"{probe} configuration missing")
    _require_exact_keys(
        configuration,
        {
            "windowSamples",
            "overlapSamples",
            "numThreads",
            "reconciliationThreshold",
        },
        f"{probe} configuration",
    )
    window_samples = configuration.get("windowSamples")
    overlap_samples = configuration.get("overlapSamples")
    _require(
        isinstance(window_samples, int) and window_samples > 0,
        f"{probe} windowSamples invalid",
    )
    _require(
        isinstance(overlap_samples, int)
        and 0 <= overlap_samples < window_samples,
        f"{probe} overlapSamples invalid",
    )
    _require(
        isinstance(configuration.get("numThreads"), int)
        and configuration["numThreads"] > 0,
        f"{probe} numThreads invalid",
    )
    _require(
        isinstance(configuration.get("reconciliationThreshold"), (int, float))
        and -1 <= configuration["reconciliationThreshold"] <= 1,
        f"{probe} reconciliationThreshold invalid",
    )
    frozen = dict((contract.get("candidate") or {}).get("frozenConfiguration") or {})
    frozen.pop("id", None)
    _require(bool(frozen), "candidate frozenConfiguration missing")
    _require(
        configuration == frozen,
        f"{probe} configuration does not match frozen contract",
    )


def _validate_device(
    evidence: dict[str, Any],
    contract: dict[str, Any],
) -> tuple[int, str]:
    device = evidence.get("device")
    _require(isinstance(device, dict), "device identity missing")
    _require_exact_keys(
        device,
        {
            "manufacturer",
            "model",
            "sdkInt",
            "buildFingerprint",
            "maximumThermalStatusRaw",
            "maximumThermalStatusName",
        },
        "device",
    )
    constraints = contract.get("deviceConstraints") or {}
    _require(
        device.get("manufacturer") == constraints.get("manufacturer")
        and device.get("model") == constraints.get("model"),
        "device does not match contract",
    )
    _require(
        isinstance(device.get("sdkInt"), int)
        and device["sdkInt"] >= int(constraints.get("minimumSdkInt", 0)),
        "device SDK does not match contract",
    )
    _require(bool(device.get("buildFingerprint")), "device build fingerprint missing")
    raw = device.get("maximumThermalStatusRaw")
    name = device.get("maximumThermalStatusName")
    thermal_names = {
        0: "none",
        1: "light",
        2: "moderate",
        3: "severe",
        4: "critical",
        5: "emergency",
        6: "shutdown",
    }
    _require(
        isinstance(raw, int) and thermal_names.get(raw) == name,
        "thermal status mismatch",
    )
    return raw, name


def _validate_fixture_consumption(
    evidence: dict[str, Any],
    expected_sha256: str,
    *,
    requires_after_hash: bool,
) -> tuple[int, int]:
    fixture = evidence.get("fixture")
    _require(isinstance(fixture, dict), "fixture identity missing")
    allowed = {"sha256", "sampleRate", "totalSamples", "consumedSamples"}
    if requires_after_hash:
        allowed.add("sha256After")
    _require_exact_keys(fixture, allowed, "fixture")
    _require(fixture.get("sha256") == expected_sha256, "fixture hash mismatch")
    if requires_after_hash:
        _require(
            fixture.get("sha256After") == expected_sha256,
            "fixture was mutated",
        )
    sample_rate = fixture.get("sampleRate")
    total_samples = fixture.get("totalSamples")
    _require(sample_rate == 16_000, "fixture sample rate must be 16000")
    _require(
        isinstance(total_samples, int) and total_samples > 0,
        "fixture totalSamples invalid",
    )
    _require(
        fixture.get("consumedSamples") == total_samples,
        "fixture input was not completely consumed",
    )
    return sample_rate, total_samples


def _validate_window_completion(
    evidence: dict[str, Any],
    total_samples: int,
    *,
    resource: bool,
) -> None:
    windows = evidence.get("windows")
    _require(isinstance(windows, dict), "window completion missing")
    allowed = {"planned", "processed", "finalWindowEndSample"}
    if resource:
        allowed.add("retainedFinalizedIntervalCount")
    _require_exact_keys(windows, allowed, "windows")
    _require(
        isinstance(windows.get("planned"), int)
        and windows["planned"] > 0
        and windows.get("processed") == windows["planned"],
        "window processing incomplete",
    )
    _require(
        windows.get("finalWindowEndSample") == total_samples,
        "final window does not reach fixture tail",
    )
    if resource:
        _require(
            windows.get("retainedFinalizedIntervalCount") == 0,
            "120-minute probe retained finalized turn detail",
        )


def _validate_functional_timings(evidence: dict[str, Any]) -> None:
    timings = evidence.get("timings")
    _require(isinstance(timings, dict), "functional timings missing")
    required = {
        "initializationMs",
        "pcmAndWindowingMs",
        "diarizationMs",
        "embeddingMs",
        "reconciliationMs",
        "stitchingMs",
        "totalMs",
    }
    _require_exact_keys(timings, required, "timings")
    _require(
        all(
            isinstance(timings.get(field), (int, float))
            and timings[field] >= 0
            for field in required
        )
        and timings["totalMs"] > 0,
        "functional timings invalid",
    )


def _semantic_turns(
    evidence: dict[str, Any],
    total_samples: int,
    sample_rate: int,
) -> tuple[list[tuple[str, float, float]], list[dict[str, Any]]]:
    raw_intervals = evidence.get("semanticIntervals")
    _require(
        isinstance(raw_intervals, list) and bool(raw_intervals),
        "semantic intervals missing",
    )
    turns: list[tuple[str, float, float]] = []
    previous_end = 0
    speaker_key_pattern = re.compile(r"^speaker_[1-9][0-9]*$")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_intervals):
        _require(isinstance(raw, dict), f"semanticIntervals[{index}] invalid")
        _require_exact_keys(
            raw,
            {
                "startSample",
                "endSampleExclusive",
                "kind",
                "meetingSpeakerKeys",
                "unknownSpeakerCount",
            },
            f"semanticIntervals[{index}]",
        )
        start = raw.get("startSample")
        end = raw.get("endSampleExclusive")
        kind = raw.get("kind")
        keys = raw.get("meetingSpeakerKeys")
        unknown_count = raw.get("unknownSpeakerCount")
        _require(
            isinstance(start, int)
            and isinstance(end, int)
            and start == previous_end
            and end > start
            and end <= total_samples,
            "semantic intervals must be ordered, contiguous, and in bounds",
        )
        _require(
            kind in {"ASSIGNED", "OVERLAP", "UNKNOWN", "SILENCE"},
            "semantic interval kind invalid",
        )
        _require(
            isinstance(keys, list)
            and len(keys) == len(set(keys))
            and all(
                isinstance(key, str) and speaker_key_pattern.fullmatch(key)
                for key in keys
            ),
            "meeting-global speaker keys invalid",
        )
        _require(
            isinstance(unknown_count, int) and unknown_count >= 0,
            "unknownSpeakerCount invalid",
        )
        if kind == "ASSIGNED":
            _require(len(keys) == 1 and unknown_count == 0, "ASSIGNED semantics invalid")
        elif kind == "OVERLAP":
            _require(len(keys) + unknown_count >= 2, "OVERLAP semantics invalid")
        elif kind == "UNKNOWN":
            _require(not keys and unknown_count >= 1, "UNKNOWN semantics invalid")
        else:
            _require(not keys and unknown_count == 0, "SILENCE semantics invalid")
        for key in keys:
            turns.append((key, start / sample_rate, end / sample_rate))
        if kind == "UNKNOWN":
            turns.append((f"unknown:{index}", start / sample_rate, end / sample_rate))
        normalized.append(raw)
        previous_end = end
    _require(previous_end == total_samples, "semantic intervals do not cover fixture")
    return turns, normalized


def _regions_have_kind(
    intervals: list[dict[str, Any]],
    regions: Any,
    *,
    kind: str,
    sample_rate: int,
) -> bool:
    if not isinstance(regions, list) or not regions:
        return False
    for region in regions:
        region_start = int(round(float(region[0]) * sample_rate))
        region_end = int(round(float(region[1]) * sample_rate))
        overlapping = [
            interval
            for interval in intervals
            if interval["startSample"] < region_end
            and interval["endSampleExclusive"] > region_start
        ]
        if not overlapping:
            return False
        if kind == "SILENCE":
            if any(interval["kind"] != kind for interval in overlapping):
                return False
        elif not any(interval["kind"] == kind for interval in overlapping):
            return False
    return True


def _evaluate_functional_probe(
    five: dict[str, Any],
    generated: dict[str, Any],
    contract: dict[str, Any],
    rttm_text: str,
    *,
    evidence_sha256: str,
) -> tuple[dict[str, Any], bool, float]:
    functional = generated.get("functional") or {}
    five_sample_rate, five_total_samples = _validate_fixture_consumption(
        five,
        str(functional.get("sha256")),
        requires_after_hash=True,
    )
    _require(
        functional.get("sha256")
        == (contract.get("fixtures", {}).get("fiveMinute") or {}).get("wavSha256"),
        "generated five-minute fixture does not match contract",
    )
    _validate_window_completion(five, five_total_samples, resource=False)
    _validate_functional_timings(five)
    _validate_device(five, contract)
    transcript = five.get("transcriptSnapshot")
    _require(isinstance(transcript, dict), "transcript snapshot hashes missing")
    _require_exact_keys(
        transcript,
        {"beforeSha256", "afterSha256"},
        "transcriptSnapshot",
    )
    transcript_before = transcript.get("beforeSha256")
    transcript_after = transcript.get("afterSha256")
    _require(
        _is_sha256(transcript_before) and _is_sha256(transcript_after),
        "transcript snapshot hashes missing",
    )
    transcript_unchanged = transcript_before == transcript_after
    duration = five_total_samples / five_sample_rate
    reference_turns = _parse_rttm(rttm_text)
    hypothesis_turns, semantic_intervals = _semantic_turns(
        five,
        five_total_samples,
        five_sample_rate,
    )
    reference_frames = _paint_frames(reference_turns, duration)
    hypothesis_frames = _paint_frames(hypothesis_turns, duration)
    annotated_frames = sum(bool(frame) for frame in reference_frames)
    covered_frames = sum(
        bool(reference) and bool(hypothesis)
        for reference, hypothesis in zip(reference_frames, hypothesis_frames)
    )
    coverage = covered_frames / max(1, annotated_frames)
    der = _best_der(reference_frames, hypothesis_frames)
    overlap_honest = _regions_have_kind(
        semantic_intervals,
        functional.get("overlapRegions"),
        kind="OVERLAP",
        sample_rate=five_sample_rate,
    )
    silence_honest = _regions_have_kind(
        semantic_intervals,
        functional.get("silenceRegions"),
        kind="SILENCE",
        sample_rate=five_sample_rate,
    )
    functional_thresholds = contract["thresholds"]["fiveMinute"]
    five_pass = (
        coverage >= float(functional_thresholds["minimumAnnotatedSpeechCoverage"])
        and der <= float(functional_thresholds["maximumDer"])
        and overlap_honest
        and silence_honest
        and transcript_unchanged
    )
    return (
        {
            "status": "PASS" if five_pass else "FAIL",
            "annotatedSpeechCoverage": coverage,
            "der": der,
            "orderedInBoundsTurns": True,
            "overlapRepresented": overlap_honest,
            "noSpeakerInPreregisteredSilence": silence_honest,
            "meetingGlobalSpeakerKeys": True,
            "transcriptSnapshotBeforeSha256": transcript_before,
            "transcriptSnapshotAfterSha256": transcript_after,
            "transcriptUnchanged": transcript_unchanged,
            "semanticIntervalCount": len(semantic_intervals),
            "evidenceSha256": evidence_sha256,
        },
        five_pass,
        duration,
    )


def evaluate_screening_evidence(
    manifest: dict[str, Any],
    contract: dict[str, Any],
    generated: dict[str, Any],
    five: dict[str, Any],
    rttm_text: str,
    *,
    functional_evidence_sha256: str,
) -> dict[str, Any]:
    _require(contract.get("schemaVersion") == 2, "contract schemaVersion must be 2")
    _require(
        manifest.get("contractSha256") == five.get("contractSha256"),
        "fiveMinute contract SHA-256 mismatch",
    )
    _require(_is_sha256(functional_evidence_sha256), "functional evidence hash missing")
    _reject_unsafe_evidence_payload(five, location="five-minute evidence")
    _require(generated.get("schemaVersion") == 2, "generated fixture schemaVersion must be 2")
    _require(
        generated.get("contractId") == contract.get("contractId"),
        "generated fixture contractId mismatch",
    )
    _require(
        generated.get("semanticContract")
        == {
            "activityWithoutAttribution": "UNKNOWN",
            "noActivity": "SILENCE",
        },
        "semantic unknown/silence contract missing",
    )
    _validate_evidence_identity(
        five,
        probe="fiveMinute",
        manifest=manifest,
        contract=contract,
    )
    _require_exact_keys(
        five,
        {
            "schemaVersion",
            "source",
            "probe",
            "contractId",
            "contractSha256",
            "candidateId",
            "configuration",
            "device",
            "fixture",
            "transcriptSnapshot",
            "windows",
            "timings",
            "semanticIntervals",
            "complete",
        },
        "five-minute evidence",
    )
    five_result, five_pass, duration = _evaluate_functional_probe(
        five,
        generated,
        contract,
        rttm_text,
        evidence_sha256=functional_evidence_sha256,
    )
    timings = five["timings"]
    initialization_ms = float(timings["initializationMs"])
    steady_state_ms = max(0.0, float(timings["totalMs"]) - initialization_ms)
    projected_duration_seconds = float(
        (contract.get("fixtures", {}).get("oneHundredTwentyMinute") or {}).get(
            "durationSeconds"
        )
    )
    projected_elapsed_ms = (
        initialization_ms
        + steady_state_ms * projected_duration_seconds / duration
    )
    projected_rtf = projected_elapsed_ms / (projected_duration_seconds * 1000.0)
    projected_rtf_pass = projected_rtf <= float(
        contract["thresholds"]["oneHundredTwentyMinute"]["maximumRtf"]
    )
    failed_gates = []
    if not five_pass:
        failed_gates.append("FUNCTIONAL")
    if not projected_rtf_pass:
        failed_gates.append("PROJECTED_RTF")
    return {
        "schemaVersion": 2,
        "decision": (
            "ADVANCE_TO_FINAL_GATE"
            if not failed_gates
            else "REJECT_CURRENT_CANDIDATE"
        ),
        "candidateId": five["candidateId"],
        "contractSha256": five["contractSha256"],
        "failedGates": failed_gates,
        "fiveMinute": five_result,
        "timings": timings,
        "projectedOneHundredTwentyMinute": {
            "durationSeconds": projected_duration_seconds,
            "initializationMsChargedOnce": initialization_ms,
            "steadyStateSourceDurationSeconds": duration,
            "steadyStateSourceElapsedMs": steady_state_ms,
            "projectedElapsedMs": projected_elapsed_ms,
            "projectedRtf": projected_rtf,
            "maximumRtf": contract["thresholds"]["oneHundredTwentyMinute"][
                "maximumRtf"
            ],
        },
    }


def evaluate_probe_evidence(
    manifest: dict[str, Any],
    contract: dict[str, Any],
    generated: dict[str, Any],
    five: dict[str, Any],
    resource: dict[str, Any],
    rttm_text: str,
    *,
    functional_evidence_sha256: str,
    resource_evidence_sha256: str,
) -> dict[str, Any]:
    validate_manifest(manifest, contract)
    _require(_is_sha256(functional_evidence_sha256), "functional evidence hash missing")
    _require(_is_sha256(resource_evidence_sha256), "resource evidence hash missing")
    _reject_unsafe_evidence_payload(five, location="five-minute evidence")
    _reject_unsafe_evidence_payload(resource, location="resource evidence")
    _require(generated.get("schemaVersion") == 2, "generated fixture schemaVersion must be 2")
    _require(
        generated.get("contractId") == contract.get("contractId"),
        "generated fixture contractId mismatch",
    )
    _require(
        generated.get("semanticContract")
        == {
            "activityWithoutAttribution": "UNKNOWN",
            "noActivity": "SILENCE",
        },
        "semantic unknown/silence contract missing",
    )
    _validate_evidence_identity(
        five,
        probe="fiveMinute",
        manifest=manifest,
        contract=contract,
    )
    _validate_evidence_identity(
        resource,
        probe="oneHundredTwentyMinute",
        manifest=manifest,
        contract=contract,
    )
    _require_exact_keys(
        five,
        {
            "schemaVersion",
            "source",
            "probe",
            "contractId",
            "contractSha256",
            "candidateId",
            "configuration",
            "device",
            "fixture",
            "transcriptSnapshot",
            "windows",
            "timings",
            "semanticIntervals",
            "complete",
        },
        "five-minute evidence",
    )
    _require_exact_keys(
        resource,
        {
            "schemaVersion",
            "source",
            "probe",
            "contractId",
            "contractSha256",
            "candidateId",
            "configuration",
            "device",
            "fixture",
            "windows",
            "memory",
            "elapsedMs",
            "completed",
            "oom",
            "anr",
            "complete",
        },
        "resource evidence",
    )
    resource_fixture = generated.get("resource") or {}
    five_result, five_pass, _ = _evaluate_functional_probe(
        five,
        generated,
        contract,
        rttm_text,
        evidence_sha256=functional_evidence_sha256,
    )

    resource_sample_rate, resource_total_samples = _validate_fixture_consumption(
        resource,
        str(resource_fixture.get("sha256")),
        requires_after_hash=False,
    )
    _require(
        resource_fixture.get("sha256")
        == (contract.get("fixtures", {}).get("oneHundredTwentyMinute") or {}).get(
            "wavSha256"
        ),
        "generated resource fixture does not match contract",
    )
    _validate_window_completion(resource, resource_total_samples, resource=True)
    thermal_raw, thermal_name = _validate_device(resource, contract)
    memory = resource.get("memory")
    _require(isinstance(memory, dict), "resource memory evidence missing")
    _require_exact_keys(memory, {"baselinePssKiB", "peakPssKiB"}, "memory")
    baseline_pss = memory.get("baselinePssKiB")
    peak_pss = memory.get("peakPssKiB")
    _require(
        isinstance(baseline_pss, int) and baseline_pss > 0,
        "baseline PSS missing",
    )
    _require(
        isinstance(peak_pss, int) and peak_pss >= baseline_pss,
        "peak PSS invalid",
    )
    incremental_peak_rss_mib = (peak_pss - baseline_pss) / 1024.0
    elapsed_ms = resource.get("elapsedMs")
    _require(
        isinstance(elapsed_ms, (int, float)) and elapsed_ms > 0,
        "resource elapsedMs invalid",
    )
    resource_duration = resource_total_samples / resource_sample_rate
    rtf = float(elapsed_ms) / (resource_duration * 1000.0)
    resource_thresholds = contract["thresholds"]["oneHundredTwentyMinute"]
    thermal_rank = {
        "none": 0,
        "light": 1,
        "moderate": 2,
        "severe": 3,
        "critical": 4,
        "emergency": 5,
        "shutdown": 6,
    }
    thermal_pass = thermal_rank[thermal_name] <= thermal_rank[
        resource_thresholds["maximumThermalStatus"]
    ]
    actual_resource_pass = (
        resource.get("completed") is True
        and resource.get("oom") is False
        and resource.get("anr") is False
        and rtf <= float(resource_thresholds["maximumRtf"])
        and incremental_peak_rss_mib
        <= float(resource_thresholds["maximumIncrementalPeakRssMiB"])
        and thermal_pass
    )
    resource_pass = actual_resource_pass
    resource_result = {
        "status": "PASS" if resource_pass else "FAIL",
        "completed": bool(resource.get("completed")),
        "oom": bool(resource.get("oom")),
        "anr": bool(resource.get("anr")),
        "rtf": rtf,
        "baselinePssKiB": baseline_pss,
        "peakPssKiB": peak_pss,
        "incrementalPeakRssMiB": incremental_peak_rss_mib,
        "maximumThermalStatusRaw": thermal_raw,
        "maximumThermalStatus": thermal_name,
        "evidenceSha256": resource_evidence_sha256,
    }
    failed_gates = []
    if not five_pass:
        failed_gates.append("FUNCTIONAL")
    if not resource_pass:
        failed_gates.append("RESOURCE")
    status = PASS_STATUS if not failed_gates else _deferred_status(failed_gates)
    return {
        "schemaVersion": 2,
        "status": status,
        "verified": status == PASS_STATUS,
        "eligibleForProductization": status == PASS_STATUS,
        "productAvailable": False,
        "failedGates": failed_gates,
        "fiveMinute": five_result,
        "oneHundredTwentyMinute": resource_result,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "manifest",
        nargs="?",
        default="benchmark/speaker_diarization_manifest.json",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=DEFAULT_CONTRACT,
    )
    parser.add_argument("--generated", type=Path)
    parser.add_argument("--five-minute-evidence", type=Path)
    parser.add_argument("--resource-evidence", type=Path)
    parser.add_argument("--rttm", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--phase", choices=("validate", "screen", "final"), default="validate")
    args = parser.parse_args()
    path = Path(args.manifest)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        contract_bytes = args.contract.read_bytes()
        contract = json.loads(contract_bytes)
        contract_sha256 = hashlib.sha256(contract_bytes).hexdigest()
        if args.phase == "screen":
            result: dict[str, Any] = {}
        else:
            _require(
                manifest.get("contractSha256") == contract_sha256,
                "manifest contractSha256 does not match the contract file",
            )
            result = validate_manifest(manifest, contract)
        if args.phase != "validate":
            common_paths = (args.generated, args.five_minute_evidence, args.rttm)
            _require(all(common_paths), "generated, five-minute evidence, and RTTM are required")
            if args.phase == "final":
                _require(args.resource_evidence is not None, "resource evidence is required")
            generated = json.loads(args.generated.read_text(encoding="utf-8"))
            rttm_bytes = args.rttm.read_bytes()
            rttm_sha256 = hashlib.sha256(rttm_bytes).hexdigest()
            _require(
                rttm_sha256
                == (contract.get("fixtures", {}).get("fiveMinute") or {}).get(
                    "rttmSha256"
                ),
                "RTTM hash does not match contract",
            )
            _require(
                rttm_sha256 == (generated.get("functional") or {}).get("rttmSha256"),
                "generated RTTM hash mismatch",
            )
            five_bytes = args.five_minute_evidence.read_bytes()
            five = json.loads(five_bytes)
            if args.phase == "screen":
                result = evaluate_screening_evidence(
                    {"contractSha256": contract_sha256},
                    contract,
                    generated,
                    five,
                    rttm_bytes.decode("utf-8"),
                    functional_evidence_sha256=hashlib.sha256(five_bytes).hexdigest(),
                )
            else:
                resource_bytes = args.resource_evidence.read_bytes()
                result = evaluate_probe_evidence(
                    manifest,
                    contract,
                    generated,
                    five,
                    json.loads(resource_bytes),
                    rttm_bytes.decode("utf-8"),
                    functional_evidence_sha256=hashlib.sha256(five_bytes).hexdigest(),
                    resource_evidence_sha256=hashlib.sha256(
                        resource_bytes
                    ).hexdigest(),
                )
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(
                    json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    if "decision" in result:
        print(
            f"{result['decision']}: failedGates={result['failedGates']} "
            f"projectedRtf={result['projectedOneHundredTwentyMinute']['projectedRtf']:.4f}"
        )
        return 0
    elif "fiveMinute" in result:
        print(
            "PASS: evaluated physical speaker evidence "
            f"(status={result['status']}, "
            f"five={result['fiveMinute']['status']}, "
            f"resource={result['oneHundredTwentyMinute']['status']})"
        )
        return 0
    print(
        "PASS: speaker diarization manifest is internally consistent "
        f"({result['status']}, "
        f"eligibleForProductization={result['eligibleForProductization']}, "
        f"productAvailable={result['productAvailable']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
