#!/usr/bin/env python3
"""Evaluate predicted transcript segment boundaries against a fixed manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "audio" / "timestamp_manifest.json"
DEFAULT_AUDIO_ROOT = ROOT / "benchmark" / "audio"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare ordered predicted start/end boundaries with the fixed "
            "timestamp manifest and enforce the P95 threshold."
        )
    )
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--audio-root", type=Path, default=DEFAULT_AUDIO_ROOT)
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--allow-provisional",
        action="store_true",
        help="Tooling-only: evaluate unreviewed boundaries without satisfying release evidence.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile_nearest_rank(values: list[int], percentile: float) -> int:
    if not values:
        raise ValueError("cannot calculate a percentile without values")
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def validate_audio(case: dict[str, Any], audio_root: Path) -> None:
    audio_path = audio_root / str(case["audio"])
    if not audio_path.is_file():
        raise ValueError(f"missing timestamp fixture: {audio_path}")
    expected_hash = str(case.get("audioSha256", ""))
    if expected_hash and sha256(audio_path) != expected_hash:
        raise ValueError(f"timestamp fixture hash mismatch: {audio_path}")


def evaluate(
    manifest: dict[str, Any],
    predictions: dict[str, Any],
    audio_root: Path,
    allow_provisional: bool,
) -> dict[str, Any]:
    prediction_schema = int(predictions.get("schemaVersion", 0))
    if prediction_schema not in {1, 2}:
        raise ValueError(f"unsupported prediction schemaVersion: {prediction_schema}")
    if not allow_provisional and prediction_schema != 2:
        raise ValueError("release evaluation requires prediction schemaVersion 2")
    prediction_source = str(predictions.get("source", "")).strip()
    if not allow_provisional and prediction_source != "physical_android_production_engine":
        raise ValueError(
            "release evaluation requires physical_android_production_engine predictions"
        )
    prediction_case_list = predictions.get("cases", [])
    if not isinstance(prediction_case_list, list):
        raise ValueError("prediction cases must be a list")
    prediction_cases: dict[str, dict[str, Any]] = {}
    for case in prediction_case_list:
        if not isinstance(case, dict) or "id" not in case:
            raise ValueError("prediction cases must be objects with ids")
        case_id = str(case["id"])
        if case_id in prediction_cases:
            raise ValueError(f"duplicate prediction case: {case_id}")
        prediction_cases[case_id] = case
    manifest_cases = manifest.get("cases", [])
    if not isinstance(manifest_cases, list):
        raise ValueError("manifest cases must be a list")
    manifest_ids = [
        str(case["id"])
        for case in manifest_cases
        if isinstance(case, dict) and "id" in case
    ]
    if len(manifest_ids) != len(manifest_cases) or len(set(manifest_ids)) != len(
        manifest_ids
    ):
        raise ValueError("manifest cases must have unique ids")
    if set(prediction_cases) != set(manifest_ids):
        raise ValueError("prediction case ids must exactly match the manifest")
    boundary_errors: list[int] = []
    case_reports: list[dict[str, Any]] = []
    release_eligible = True
    for case in manifest_cases:
        if not isinstance(case, dict):
            raise ValueError("manifest cases must be objects")
        validate_audio(case, audio_root)
        case_id = str(case["id"])
        review_status = str(case.get("reviewStatus", "provisional"))
        if review_status == "approved":
            reviewed_by = str(case.get("reviewedBy", "")).strip()
            reviewed_at = str(case.get("reviewedAt", "")).strip()
            if not reviewed_by or not reviewed_at:
                raise ValueError(
                    f"{case_id} is approved without reviewedBy/reviewedAt metadata"
                )
        if review_status != "approved":
            release_eligible = False
            if not allow_provisional:
                raise ValueError(
                    f"{case_id} is {review_status}; independent boundary review is required"
                )
        predicted = prediction_cases.get(case_id)
        if predicted is None:
            raise ValueError(f"missing prediction case: {case_id}")
        expected_audio_hash = str(case.get("reviewClipSha256", ""))
        if not expected_audio_hash:
            raise ValueError(f"{case_id} manifest is missing reviewClipSha256")
        predicted_audio_hash = str(predicted.get("audioSha256", ""))
        if not allow_provisional and not predicted_audio_hash:
            raise ValueError(f"{case_id} prediction is missing audioSha256")
        if predicted_audio_hash and predicted_audio_hash != expected_audio_hash:
            raise ValueError(f"{case_id} prediction review-clip audioSha256 mismatch")
        references = case.get("referenceSegments", [])
        segments = predicted.get("segments", [])
        if len(segments) != len(references):
            raise ValueError(
                f"{case_id} segment count mismatch: "
                f"expected {len(references)}, got {len(segments)}"
            )
        case_errors: list[int] = []
        previous_end = 0
        for index, (reference, segment) in enumerate(zip(references, segments)):
            if int(segment.get("sequenceId", -1)) != index:
                raise ValueError(f"{case_id} predicted sequence is not contiguous")
            start = int(segment["startMs"])
            end = int(segment["endMs"])
            if start < previous_end or end <= start:
                raise ValueError(f"{case_id} predicted segment {index} has invalid bounds")
            previous_end = end
            case_errors.extend(
                [
                    abs(start - int(reference["startMs"])),
                    abs(end - int(reference["endMs"])),
                ]
            )
        boundary_errors.extend(case_errors)
        case_reports.append(
            {
                "id": case_id,
                "reviewStatus": review_status,
                "boundaryCount": len(case_errors),
                "maxErrorMs": max(case_errors, default=0),
                "p95ErrorMs": percentile_nearest_rank(case_errors, 0.95),
            }
        )

    threshold = int(manifest.get("thresholdP95Ms", 1500))
    p95 = percentile_nearest_rank(boundary_errors, 0.95)
    passed = p95 <= threshold
    return {
        "schemaVersion": 1,
        "passed": passed,
        "releaseEligible": release_eligible,
        "predictionSource": prediction_source or "tooling_fixture",
        "predictionSchemaVersion": prediction_schema,
        "thresholdP95Ms": threshold,
        "p95ErrorMs": p95,
        "boundaryCount": len(boundary_errors),
        "cases": case_reports,
    }


def main() -> int:
    args = parse_args()
    try:
        report = evaluate(
            manifest=load_json(args.manifest),
            predictions=load_json(args.predictions),
            audio_root=args.audio_root,
            allow_provisional=args.allow_provisional,
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Timestamp evaluation blocked: {error}")
        return 1
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    print(payload)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload + "\n")
    if not report["passed"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
