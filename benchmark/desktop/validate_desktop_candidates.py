#!/usr/bin/env python3
"""Validate the target-specific U6 candidate matrix and frozen decision."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


EXPECTED_MATRIX = {
    "asr.zh": {
        "sherpa-streaming-zipformer-zh-14m-2023-02-23",
        "funasr-paraformer-vad-punctuation",
    },
    "diarization": {
        "sherpa-pyannote-3.0-3dspeaker",
        "pyannote-community-1",
    },
}
REQUIRED_FUNASR_GATES = {
    "paraformer",
    "vad",
    "punctuation",
    "itnRequested",
    "timestamps",
    "cer",
    "rtf",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def evidence_references(candidate: dict[str, Any]) -> list[dict[str, Any]]:
    evidence = candidate.get("evidence")
    if isinstance(evidence, dict):
        return [evidence]
    if isinstance(evidence, list) and all(isinstance(item, dict) for item in evidence):
        return evidence
    raise ValueError(f"{candidate.get('id')} evidence is invalid")


def validate_evidence(
    candidate: dict[str, Any], repository_root: Path | None
) -> None:
    for evidence in evidence_references(candidate):
        relative = evidence.get("path")
        expected_hash = evidence.get("sha256")
        require(
            isinstance(relative, str)
            and relative
            and not Path(relative).is_absolute()
            and ".." not in Path(relative).parts,
            f"{candidate['id']} evidence path is unsafe",
        )
        require(
            isinstance(expected_hash, str)
            and len(expected_hash) == 64
            and all(character in "0123456789abcdef" for character in expected_hash),
            f"{candidate['id']} evidence hash is invalid",
        )
        if repository_root is None:
            continue
        source = repository_root / relative
        require(source.is_file(), f"{candidate['id']} evidence is missing")
        actual_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        require(
            actual_hash == expected_hash,
            f"{candidate['id']} evidence hash mismatch",
        )


def validate(
    contract: dict[str, Any],
    registry: dict[str, Any],
    repository_root: Path | None = None,
) -> None:
    require(
        contract.get("decisionPlatform") == "macos",
        "this decision contract must be macOS target-specific",
    )
    require(registry.get("schemaVersion") == 2, "registry schema must be v2")
    require(registry.get("decisionPlatform") == "macos", "registry target mismatch")
    require(
        registry.get("benchmarkContract")
        == "benchmark/desktop/desktop_benchmark_contract.json",
        "benchmark contract path mismatch",
    )
    fingerprint = registry.get("targetFingerprint")
    require(isinstance(fingerprint, dict), "target fingerprint is required")
    require(
        set(fingerprint)
        == {
            "operatingSystemVersion",
            "architecture",
            "cpuModel",
            "logicalCpuCount",
            "memoryBytes",
        },
        "target fingerprint fields mismatch",
    )
    require(
        fingerprint.get("architecture") == "arm64"
        and fingerprint.get("logicalCpuCount", 0) > 0
        and fingerprint.get("memoryBytes", 0) > 0,
        "target fingerprint values are invalid",
    )

    candidates = registry.get("candidates")
    require(isinstance(candidates, list), "candidate list is missing")
    require(len(candidates) == 4, "candidate matrix must contain four entries")
    require(
        "whisper" not in json.dumps(candidates).lower(),
        "Whisper candidates are outside the product contract",
    )
    by_capability: dict[str, set[str]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        require(isinstance(candidate, dict), "candidate entry is invalid")
        candidate_id = candidate.get("id")
        capability = candidate.get("capability")
        require(
            isinstance(candidate_id, str) and candidate_id not in by_id,
            "candidate ids must be unique strings",
        )
        require(
            capability in EXPECTED_MATRIX,
            f"{candidate_id} capability is invalid",
        )
        by_id[candidate_id] = candidate
        by_capability.setdefault(capability, set()).add(candidate_id)
        validate_evidence(candidate, repository_root)
        disposition = candidate.get("licenseDisposition")
        require(isinstance(disposition, str), f"{candidate_id} license is missing")
        if candidate.get("status") == "SELECTED":
            require(
                disposition.startswith("PRODUCT_ELIGIBLE"),
                f"{candidate_id} is selected without product license admission",
            )
        if disposition.startswith("LAB_ONLY"):
            require(
                candidate.get("status") == "LAB_ONLY"
                and isinstance(candidate.get("hardFailures"), list)
                and candidate["hardFailures"]
                and candidate.get("metrics") is None,
                f"{candidate_id} LAB_ONLY contract is incomplete",
            )
    require(by_capability == EXPECTED_MATRIX, "candidate matrix is not the fixed U6 set")

    funasr = by_id["funasr-paraformer-vad-punctuation"]
    require(
        set(funasr.get("absoluteGates", {})) == REQUIRED_FUNASR_GATES
        and set(funasr["absoluteGates"].values()) == {"PASS"},
        "FunASR did not exercise the required component and metric gates",
    )
    funasr_metrics = funasr.get("metrics", {})
    require(
        all(
            isinstance(funasr_metrics.get(metric), (int, float))
            for metric in (
                "cer",
                "rtf",
                "coldStartupSeconds",
                "incrementalPeakRssBytes",
            )
        ),
        "FunASR comparable metrics are incomplete",
    )
    require(
        funasr.get("status") == "NOT_SELECTED_COST_EXCEEDS_BENEFIT"
        and len(funasr.get("failedSelectionGates", [])) >= 3
        and funasr.get("relativeToSherpa", {}).get("qualityBenefit") is False
        and funasr.get("relativeToSherpa", {}).get("costBenefit") is False,
        "FunASR losing disposition is not evidence-backed",
    )

    pyannote = by_id["pyannote-community-1"]
    require(
        pyannote.get("modelRevision")
        == "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee",
        "pyannote model revision is not immutable",
    )
    require(
        "USER_CONDITIONS_NOT_ACCEPTED" in pyannote.get("hardFailures", []),
        "pyannote user conditions must fail closed",
    )

    decision = registry.get("machineDecision")
    require(isinstance(decision, dict), "machine decision is missing")
    require(decision.get("status") == "FINALISTS_FROZEN", "finalists are not frozen")
    require(
        decision.get("hardFailuresAppliedBeforeBenefits") is True,
        "hard failures were not applied first",
    )
    winners = decision.get("winners")
    require(
        winners
        == {
            "asr": "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            "diarization": "sherpa-pyannote-3.0-3dspeaker",
        },
        "machine winners differ from the frozen U6 decision",
    )
    for capability, winner in winners.items():
        expected_capability = "asr.zh" if capability == "asr" else capability
        require(
            by_id[winner].get("capability") == expected_capability
            and by_id[winner].get("status") == "SELECTED",
            f"{capability} winner is not the selected candidate",
        )
    selected = [candidate for candidate in candidates if candidate["status"] == "SELECTED"]
    require(len(selected) == 2, "exactly one winner per capability is required")
    require(
        decision.get("sidecarWinner") is None
        and decision.get("productSidecarDeliveryRequired") is False
        and decision.get("selectedRuntime") == "sherpa-onnx-c-api@1.13.4",
        "native winner and sidecar delivery decision disagree",
    )
    require(
        isinstance(decision.get("noticesRequired"), list)
        and len(decision["noticesRequired"]) == 3,
        "selected model notices are incomplete",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--repository-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        validate(
            json.loads(args.contract.read_text()),
            json.loads(args.candidates.read_text()),
            args.repository_root.resolve(),
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"desktop candidates invalid: {error}")
        return 1
    print("desktop candidates: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
