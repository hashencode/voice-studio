#!/usr/bin/env python3
"""Validate the one-fallback speaker diarization decision ladder."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MATRIX = ROOT / "benchmark/speaker_diarization_candidates.json"
DEFAULT_CONTRACT = ROOT / "benchmark/speaker_diarization_admission_contract.json"


class CandidateMatrixError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CandidateMatrixError(message)


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdefABCDEF" for char in value)
    )


def validate_candidates(
    matrix: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    _require(matrix.get("schemaVersion") == 1, "candidate matrix schemaVersion must be 1")
    _require(matrix.get("maximumActiveFallbacks") == 1, "only one fallback is allowed")
    fixed = matrix.get("fixedAdmissionInputs") or {}
    fixtures = contract.get("fixtures") or {}
    thresholds = contract.get("thresholds") or {}
    expected_fixed = {
        "fiveMinuteWavSha256": fixtures["fiveMinute"]["wavSha256"],
        "fiveMinuteRttmSha256": fixtures["fiveMinute"]["rttmSha256"],
        "oneHundredTwentyMinuteWavSha256": fixtures["oneHundredTwentyMinute"][
            "wavSha256"
        ],
        "minimumAnnotatedSpeechCoverage": thresholds["fiveMinute"][
            "minimumAnnotatedSpeechCoverage"
        ],
        "maximumDer": thresholds["fiveMinute"]["maximumDer"],
        "maximumRtf": thresholds["oneHundredTwentyMinute"]["maximumRtf"],
        "maximumIncrementalPeakRssMiB": thresholds["oneHundredTwentyMinute"][
            "maximumIncrementalPeakRssMiB"
        ],
        "maximumThermalStatus": thresholds["oneHundredTwentyMinute"][
            "maximumThermalStatus"
        ],
    }
    _require(fixed == expected_fixed, "fallback changed a frozen fixture or threshold")

    current = matrix.get("currentCandidate") or {}
    _require(
        current.get("decision") == "REJECT_CURRENT_CANDIDATE",
        "fallback cannot activate before current candidate rejection",
    )
    _require(
        isinstance(current.get("failedGates"), list)
        and bool(current["failedGates"]),
        "current candidate hard failure missing",
    )
    _require(
        _is_sha256(current.get("functionalEvidenceSha256"))
        and _is_sha256(current.get("screeningEvaluationSha256")),
        "current candidate screening hashes missing",
    )

    candidates = matrix.get("candidates")
    _require(isinstance(candidates, list) and bool(candidates), "candidate matrix is empty")
    ids = [item.get("id") for item in candidates if isinstance(item, dict)]
    _require(len(ids) == len(candidates) == len(set(ids)), "candidate ids must be unique")
    required_score_fields = {
        "id",
        "fullPipeline",
        "androidBinding",
        "modelLicensesComplete",
        "artifactIdentitiesFixed",
        "sharedRuntimeImpact",
        "packageBytes",
        "mobileMemoryRisk",
        "mobileRtfRisk",
        "overlapCapability",
        "chineseMeetingRisk",
        "selectionStatus",
        "rejectionReason",
    }
    active = []
    screened = []
    for candidate in candidates:
        missing = required_score_fields - set(candidate)
        _require(not missing, f"{candidate.get('id')} scorecard incomplete: {sorted(missing)}")
        if candidate["selectionStatus"] == "ACTIVE_FALLBACK":
            active.append(candidate)
        elif candidate["selectionStatus"] == "REJECTED_SCREEN":
            screened.append(candidate)
        else:
            _require(
                bool(candidate.get("rejectionReason")),
                f"{candidate.get('id')} static rejection reason missing",
            )
    decision = matrix.get("decision")
    if decision == "DEFERRED_NO_ADMISSIBLE_CANDIDATE":
        _require(not active, "closed matrix cannot retain an active fallback")
        _require(len(screened) == 1, "exactly one fallback must be screened")
        selected = screened[0]
        _require(
            selected.get("id") == matrix.get("selectedFallbackId"),
            "screened fallback does not match selectedFallbackId",
        )
        _require(
            selected.get("failedGates") == ["FUNCTIONAL", "PROJECTED_RTF"],
            "screened fallback hard failures missing",
        )
        _require(
            _is_sha256(selected.get("functionalEvidenceSha256"))
            and _is_sha256(selected.get("screeningEvaluationSha256")),
            "screened fallback evidence hashes missing",
        )
    else:
        _require(len(active) == 1, "exactly one fallback must be active")
        selected = active[0]
    _require(selected.get("fullPipeline") is True, "active fallback is not a full pipeline")
    _require(bool(selected.get("androidBinding")), "active fallback has no Android binding")
    _require(
        selected.get("modelLicensesComplete") is True,
        "active fallback model license is incomplete",
    )
    _require(
        selected.get("artifactIdentitiesFixed") is True,
        "active fallback artifact identity is incomplete",
    )
    for key in ("runtimeSha256", "segmentationSha256", "embeddingSha256"):
        _require(_is_sha256(selected.get(key)), f"active fallback {key} missing")
    for key in ("segmentationBytes", "embeddingBytes", "packageBytes"):
        _require(
            isinstance(selected.get(key), int) and selected[key] > 0,
            f"active fallback {key} missing",
        )
    _require(
        selected.get("sharedRuntimeImpact") == "NONE",
        "shared runtime fallback requires separate regression evidence",
    )
    return {
        "selectedFallbackId": selected["id"],
        "activeFallbackCount": len(active),
        "decision": decision or "SCREEN_FALLBACK",
        "candidateCount": len(candidates),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    args = parser.parse_args()
    try:
        result = validate_candidates(
            json.loads(args.matrix.read_text(encoding="utf-8")),
            json.loads(args.contract.read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, TypeError, KeyError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print(
        "PASS: speaker fallback ladder is internally consistent "
        f"({result['decision']}, selected={result['selectedFallbackId']}, "
        f"candidates={result['candidateCount']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
