#!/usr/bin/env python3
"""Evaluate preregistered GTCRN raw/enhanced physical-device evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

try:
    from benchmark.evaluate_online_transducer_candidate import alignment, normalize
except ModuleNotFoundError:
    from evaluate_online_transducer_candidate import alignment, normalize


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "audio" / "s2_noise_manifest.json"
DEFAULT_GENERATED = ROOT / "build" / "asr_benchmark" / "s2_noise" / "generated_manifest.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--identity-evidence", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--generated-manifest", type=Path, default=DEFAULT_GENERATED)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile_nearest_rank(values: list[int], percentile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def transcript_metrics(result: dict[str, Any], reference: str) -> dict[str, Any]:
    if result.get("status") != "ok":
        raise ValueError(f"transcription failed: {result.get('error', 'unknown error')}")
    segments = result.get("segments")
    if not isinstance(segments, list):
        raise ValueError("transcription segments must be a list")
    previous_end = 0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ValueError("every transcription segment must be an object")
        start = int(segment["startMs"])
        end = int(segment["endMs"])
        if (
            int(segment.get("sequenceId", -1)) != index
            or start < previous_end
            or end <= start
        ):
            raise ValueError("transcription segments must be contiguous and ordered")
        previous_end = end
    hypothesis = normalize(str(result["text"]))
    distance, _ = alignment(reference, hypothesis)
    rtf = float(result["rtf"])
    transcription_ms = int(result["transcriptionMs"])
    if not math.isfinite(rtf) or rtf < 0.0 or transcription_ms < 0:
        raise ValueError("transcription timing metrics must be finite and non-negative")
    return {
        "cer": distance / max(1, len(reference)),
        "editDistance": distance,
        "hypothesisCharacters": len(hypothesis),
        "rtf": rtf,
        "transcriptionMs": transcription_ms,
        "segmentCount": len(segments),
    }


def paired_boundary_p95(raw: dict[str, Any], enhanced: dict[str, Any]) -> int | None:
    raw_segments = raw.get("segments", [])
    enhanced_segments = enhanced.get("segments", [])
    if len(raw_segments) != len(enhanced_segments):
        return None
    errors: list[int] = []
    for raw_segment, enhanced_segment in zip(raw_segments, enhanced_segments):
        errors.extend(
            [
                abs(int(raw_segment["startMs"]) - int(enhanced_segment["startMs"])),
                abs(int(raw_segment["endMs"]) - int(enhanced_segment["endMs"])),
            ]
        )
    return percentile_nearest_rank(errors, 0.95)


def index_cases(cases: Any, *, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(cases, list):
        raise ValueError(f"{label} cases must be a list")
    indexed: dict[str, dict[str, Any]] = {}
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError(f"every {label} case must be an object")
        case_id = str(case.get("id", ""))
        if not case_id:
            raise ValueError(f"{label} case id must be non-empty")
        if case_id in indexed:
            raise ValueError(f"duplicate {label} case id: {case_id}")
        indexed[case_id] = case
    return indexed


def evaluate(
    manifest: dict[str, Any],
    generated: dict[str, Any],
    evidence: dict[str, Any],
    identity: dict[str, Any],
    evidence_sha256: str,
    root: Path = ROOT,
) -> dict[str, Any]:
    if (
        manifest.get("schemaVersion") != 1
        or generated.get("schemaVersion") != 1
        or evidence.get("schemaVersion") != 1
        or identity.get("schemaVersion") != 1
    ):
        raise ValueError("all enhancement evidence schemaVersion values must be 1")
    if evidence.get("source") != "physical_android_instrumentation":
        raise ValueError("enhancement evidence must be physical Android instrumentation")
    if evidence.get("complete") is not True:
        raise ValueError("enhancement evidence is incomplete")
    if evidence.get("enhancementModelSha256") != manifest["model"]["sha256"]:
        raise ValueError("enhancement model hash mismatch")
    if identity.get("source") != "physical_android_instrumentation":
        raise ValueError("model identity must be physical Android instrumentation")
    if identity.get("pairedReportSha256") != evidence_sha256:
        raise ValueError("model identity is not bound to this paired report")
    recognition_model = manifest["recognitionModel"]
    if identity.get("recognitionModelId") != recognition_model["id"]:
        raise ValueError("recognition model id mismatch")
    if identity.get("recognitionModelSha256") != recognition_model["modelSha256"]:
        raise ValueError("recognition model hash mismatch")
    if identity.get("recognitionTokensSha256") != recognition_model["tokensSha256"]:
        raise ValueError("recognition tokens hash mismatch")
    if identity.get("enhancementModelSha256") != manifest["model"]["sha256"]:
        raise ValueError("identity enhancement model hash mismatch")
    for device_field in ("manufacturer", "model", "sdkInt"):
        if identity.get(device_field) != evidence.get(device_field):
            raise ValueError(f"identity {device_field} does not match paired evidence")
    source_audio = root / manifest["source"]["audio"]
    reference_file = root / manifest["source"]["reference"]
    if sha256(source_audio) != manifest["source"]["audioSha256"]:
        raise ValueError("source audio hash mismatch")
    if sha256(reference_file) != manifest["source"]["referenceSha256"]:
        raise ValueError("source reference hash mismatch")
    reference = normalize(reference_file.read_text(encoding="utf-8"))
    configured = index_cases(manifest.get("cases"), label="configured")
    generated_by_id = index_cases(generated.get("cases"), label="generated")
    evidence_by_id = index_cases(evidence.get("cases"), label="physical")
    if set(configured) != set(generated_by_id) or set(configured) != set(evidence_by_id):
        raise ValueError("configured, generated, and physical case ids differ")

    thresholds = manifest["preregisteredGates"]
    case_reports: list[dict[str, Any]] = []
    for case_id, case_config in configured.items():
        generated_case = generated_by_id[case_id]
        generated_path = Path(generated_case["path"])
        if not generated_path.is_file() or sha256(generated_path) != generated_case["sha256"]:
            raise ValueError(f"generated fixture hash mismatch: {case_id}")
        case = evidence_by_id[case_id]
        if case.get("inputSha256") != generated_case["sha256"]:
            raise ValueError(f"physical input hash mismatch: {case_id}")
        if not case.get("sourcePreserved"):
            raise ValueError(f"source was not preserved: {case_id}")
        raw_metrics = transcript_metrics(case["raw"], reference)
        enhanced_metrics = transcript_metrics(case["enhanced"], reference)
        java_before = case.get("javaHeapBeforeBytes")
        native_before = case.get("nativeHeapBeforeBytes")
        enhancement_rtf = float(case["enhancementRtf"])
        combined_enhanced_rtf = float(case["combinedEnhancedRtf"])
        if (
            not math.isfinite(enhancement_rtf)
            or enhancement_rtf < 0.0
            or not math.isfinite(combined_enhanced_rtf)
            or combined_enhanced_rtf < 0.0
        ):
            raise ValueError(f"invalid enhancement timing metrics: {case_id}")
        java_delta = (
            int(case["peakSampledJavaHeapBytes"]) - int(java_before)
            if java_before is not None
            else None
        )
        native_delta = (
            int(case["peakSampledNativeHeapBytes"]) - int(native_before)
            if native_before is not None
            else None
        )
        if java_delta is not None and java_delta < 0:
            raise ValueError(f"invalid Java heap peak measurement: {case_id}")
        if native_delta is not None and native_delta < 0:
            raise ValueError(f"invalid native heap peak measurement: {case_id}")
        case_reports.append(
            {
                "id": case_id,
                "kind": case_config["kind"],
                "isNoiseCase": case_config.get("noiseSnrDb") is not None,
                "raw": raw_metrics,
                "enhanced": enhanced_metrics,
                "cerAbsoluteChange": enhanced_metrics["cer"] - raw_metrics["cer"],
                "enhancementRtf": enhancement_rtf,
                "combinedEnhancedRtf": combined_enhanced_rtf,
                "pairedBoundaryP95DeltaMs": paired_boundary_p95(
                    case["raw"], case["enhanced"]
                ),
                "javaHeapDeltaBytes": java_delta,
                "nativeHeapDeltaBytes": native_delta,
                "sourcePreserved": True,
            }
        )

    by_id = {case["id"]: case for case in case_reports}
    quiet_change = by_id["quiet_clean"]["cerAbsoluteChange"]
    noise_cases = [case for case in case_reports if case["isNoiseCase"]]
    mean_raw_noise = sum(case["raw"]["cer"] for case in noise_cases) / len(noise_cases)
    mean_enhanced_noise = sum(
        case["enhanced"]["cer"] for case in noise_cases
    ) / len(noise_cases)
    noise_improvement = mean_raw_noise - mean_enhanced_noise
    memory_measured = all(
        case["javaHeapDeltaBytes"] is not None
        and case["nativeHeapDeltaBytes"] is not None
        for case in case_reports
    )
    paired_timestamp_values = [
        case["pairedBoundaryP95DeltaMs"]
        for case in case_reports
        if case["pairedBoundaryP95DeltaMs"] is not None
    ]
    state_before = evidence.get("deviceStateBefore", {})
    state_after = evidence.get("deviceStateAfter", {})
    thermal_statuses = [
        value
        for value in (
            state_before.get("thermalStatus"),
            state_after.get("thermalStatus"),
        )
        if isinstance(value, int)
    ]
    thermal_pass = bool(thermal_statuses) and max(thermal_statuses) < 3

    gates = {
        "quietCerRegression": {
            "value": quiet_change,
            "maximum": thresholds["quietCerAbsoluteRegressionMax"],
            "passed": quiet_change <= thresholds["quietCerAbsoluteRegressionMax"],
        },
        "meanNoiseCerImprovement": {
            "value": noise_improvement,
            "minimum": thresholds["noiseMeanCerAbsoluteImprovementMin"],
            "passed": noise_improvement
            >= thresholds["noiseMeanCerAbsoluteImprovementMin"],
        },
        "perNoiseCaseCerRegression": {
            "maximumObserved": max(case["cerAbsoluteChange"] for case in noise_cases),
            "maximum": thresholds["perNoiseCaseCerAbsoluteRegressionMax"],
            "passed": all(
                case["cerAbsoluteChange"]
                <= thresholds["perNoiseCaseCerAbsoluteRegressionMax"]
                for case in noise_cases
            ),
        },
        "enhancementRtf": {
            "maximumObserved": max(case["enhancementRtf"] for case in case_reports),
            "maximum": thresholds["enhancementRtfMax"],
            "passed": all(
                case["enhancementRtf"] <= thresholds["enhancementRtfMax"]
                for case in case_reports
            ),
        },
        "combinedRtf": {
            "maximumObserved": max(case["combinedEnhancedRtf"] for case in case_reports),
            "maximum": thresholds["combinedPipelineRtfMax"],
            "passed": all(
                case["combinedEnhancedRtf"] <= thresholds["combinedPipelineRtfMax"]
                for case in case_reports
            ),
        },
        "memory": {
            "measured": memory_measured,
            "maximumJavaDeltaBytes": max(
                (case["javaHeapDeltaBytes"] or 0) for case in case_reports
            ),
            "maximumNativeDeltaBytes": max(
                (case["nativeHeapDeltaBytes"] or 0) for case in case_reports
            ),
            "passed": memory_measured
            and all(
                case["javaHeapDeltaBytes"]
                <= thresholds["peakJavaHeapDeltaBytesMax"]
                and case["nativeHeapDeltaBytes"]
                <= thresholds["peakNativeHeapDeltaBytesMax"]
                for case in case_reports
            ),
        },
        "pairedTimestampDelta": {
            "comparableCaseCount": len(paired_timestamp_values),
            "maximumObservedP95Ms": (
                max(paired_timestamp_values) if paired_timestamp_values else None
            ),
            "maximum": thresholds["timestampP95DeltaMsMax"],
            "passed": len(paired_timestamp_values) == len(case_reports)
            and max(paired_timestamp_values, default=10**9)
            <= thresholds["timestampP95DeltaMsMax"],
            "releaseEligible": False,
            "reason": "independent_timestamp_reference_missing",
        },
        "thermal": {
            "before": state_before.get("thermalStatus"),
            "after": state_after.get("thermalStatus"),
            "passed": thermal_pass,
        },
        "sourcePreservation": {
            "passed": all(case["sourcePreserved"] for case in case_reports),
        },
    }
    technical_mid_pass = all(gate["passed"] for gate in gates.values())
    return {
        "schemaVersion": 1,
        "source": evidence["source"],
        "deviceClass": evidence.get("deviceClass"),
        "device": {
            "manufacturer": evidence.get("manufacturer"),
            "model": evidence.get("model"),
            "sdkInt": evidence.get("sdkInt"),
        },
        "cases": case_reports,
        "meanRawNoiseCer": mean_raw_noise,
        "meanEnhancedNoiseCer": mean_enhanced_noise,
        "gates": gates,
        "batteryObservation": {
            "capacityBeforePercent": state_before.get("batteryCapacityPercent"),
            "capacityAfterPercent": state_after.get("batteryCapacityPercent"),
            "chargeCounterBeforeMicroAh": state_before.get(
                "batteryChargeCounterMicroAh"
            ),
            "chargeCounterAfterMicroAh": state_after.get(
                "batteryChargeCounterMicroAh"
            ),
        },
        "midDeviceTechnicalGatesPassed": technical_mid_pass,
        "releaseEligible": False,
        "productGatePassed": False,
        "releaseBlockers": [
            "independently_reviewed_timestamp_evidence_missing",
            "low_device_physical_evidence_missing",
            "aec_unavailable",
            *(
                []
                if technical_mid_pass
                else ["one_or_more_mid_device_preregistered_gates_failed"]
            ),
        ],
    }


def main() -> int:
    args = parse_args()
    try:
        report = evaluate(
            load_json(args.manifest),
            load_json(args.generated_manifest),
            load_json(args.evidence),
            load_json(args.identity_evidence),
            sha256(args.evidence),
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"S2 enhancement evaluation blocked: {error}")
        return 1
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    print(payload)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
