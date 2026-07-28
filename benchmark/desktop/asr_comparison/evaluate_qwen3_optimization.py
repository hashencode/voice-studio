#!/usr/bin/env python3
"""Validate and evaluate bounded, single-variable Qwen3-ASR experiments."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = Path(__file__).with_name("qwen3_optimization_contract.json")


class Qwen3OptimizationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Qwen3OptimizationError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mapping(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def validate_contract(
    contract: dict[str, Any],
    *,
    root: Path = ROOT,
    validate_files: bool = True,
) -> None:
    require(contract.get("schemaVersion") == 2, "contract schema changed")
    require(
        contract.get("developmentPosture") == "DEVELOPMENT_ONLY",
        "optimization must remain DEVELOPMENT_ONLY",
    )
    require(contract.get("maximumProbeMinutes") == 30, "probe exceeds 30 minutes")
    target = mapping(contract.get("target"), "target")
    require(
        target
        == {
            "os": "macOS 15.7.5",
            "osBuild": "24G624",
            "architecture": "arm64",
            "cpu": "Apple M4",
            "logicalCpuCount": 10,
            "memoryBytes": 17179869184,
            "buildMode": "debug",
        },
        "target fingerprint drifted",
    )
    inputs = mapping(contract.get("inputs"), "inputs")
    if validate_files:
        for prefix in ("fixtureManifest", "scoringContract"):
            path = root / inputs[f"{prefix}Path"]
            require(path.is_file(), f"{prefix} file is missing")
            require(
                sha256(path) == inputs[f"{prefix}Sha256"],
                f"{prefix} hash drifted",
            )
    control = mapping(contract.get("control"), "control")
    expected_control = {
        "runtime": "sherpa-onnx-1.13.4-ort-1.27.0",
        "runtimeSha256": "809ab5d0c77bd8f358364a244e6ab17f2afecf9779eb9fd436fa469c3ff5375c",
        "provider": "cpu",
        "threads": 2,
        "concurrency": 1,
        "segmentation": "fixed",
        "segmentDurationSeconds": 15,
        "maxSpeechSeconds": 20,
        "vadThreshold": 0.2,
        "minSpeechSeconds": 0.2,
        "hotwords": "",
        "maxTotalLen": 512,
        "maxNewTokens": 512,
        "temperature": 0.000001,
        "topP": 0.8,
        "seed": 42,
    }
    require(control == expected_control, "Qwen3 control drifted")
    allowed = {
        "runtime",
        "hotwords",
        "segmentation",
        "maxSpeechSeconds",
        "maxNewTokens",
    }
    seen: set[str] = {"control"}
    for raw in contract.get("arms", []):
        arm = mapping(raw, "arm")
        require(arm.get("id") not in seen, "duplicate arm id")
        base_arm_id = arm.get("baseArmId")
        require(
            isinstance(base_arm_id, str) and base_arm_id in seen,
            "arm base must reference control or an earlier arm",
        )
        variable = arm.get("variable")
        require(variable in allowed, "arm changes an unregistered variable")
        require(arm.get("value") != control[variable], "arm does not change its variable")
        extra = set(arm) - {
            "id",
            "baseArmId",
            "variable",
            "value",
            "runtimeSha256",
        }
        require(not extra, "arm contains multiple-variable fields")
        if variable == "runtime":
            require(
                isinstance(arm.get("runtimeSha256"), str)
                and len(arm["runtimeSha256"]) == 64,
                "runtime arm requires a pinned hash",
            )
        else:
            require("runtimeSha256" not in arm, "non-runtime arm changes runtime")
        seen.add(arm["id"])


def bounded_hotwords(terms: list[str], bounds: dict[str, Any]) -> list[str]:
    import unicodedata

    maximum_terms = int(bounds["maximumTerms"])
    maximum_term_chars = int(bounds["maximumTermCharacters"])
    maximum_total_chars = int(bounds["maximumTotalCharacters"])
    result: list[str] = []
    seen: set[str] = set()
    total = 0
    for raw in terms:
        require(isinstance(raw, str), "hotwords must be strings")
        value = unicodedata.normalize("NFKC", raw).strip()
        require("\x00" not in value and "\n" not in value, "hotword contains control data")
        if not value or value in seen:
            continue
        require(len(value) <= maximum_term_chars, "hotword is too long")
        require(total + len(value) <= maximum_total_chars, "hotword pack is too large")
        seen.add(value)
        result.append(value)
        total += len(value)
        require(len(result) <= maximum_terms, "too many hotwords")
    return result


def _finite_number(value: Any, label: str) -> float:
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{label} must be finite",
    )
    return float(value)


def validate_result(
    result: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    validate_contract(contract)
    require(result.get("schemaVersion") == 2, "result schema changed")
    require(
        result.get("contractId") == contract["contractId"],
        "result contract mismatch",
    )
    require(result.get("status") in {"COMPLETE", "BLOCKED"}, "result status invalid")
    if result["status"] == "BLOCKED":
        missing = result.get("missingInputs")
        require(isinstance(missing, list) and missing, "blocked result needs missing inputs")
        return {
            "status": "PENDING_FIXED_INPUTS",
            "selectedArm": "control",
            "reason": "required fixed inputs are unavailable",
        }
    require(result.get("target") == contract["target"], "result target drifted")
    require(
        result.get("fixtureManifestSha256")
        == contract["inputs"]["fixtureManifestSha256"]
        and result.get("scoringContractSha256")
        == contract["inputs"]["scoringContractSha256"],
        "result input hashes drifted",
    )
    observations = result.get("arms")
    require(isinstance(observations, list) and observations, "result arms missing")
    by_id = {item["id"]: item for item in observations}
    require("control" in by_id, "control observation missing")
    registered = {"control", *(arm["id"] for arm in contract["arms"])}
    require(set(by_id) <= registered, "unregistered arm result")
    arm_contracts = {arm["id"]: arm for arm in contract["arms"]}
    for arm_id, item in by_id.items():
        require(item.get("changedVariable") == (
            None if arm_id == "control" else next(
                arm["variable"] for arm in contract["arms"] if arm["id"] == arm_id
            )
        ), "arm changed-variable declaration mismatch")
        require(
            item.get("baseArmId")
            == (None if arm_id == "control" else arm_contracts[arm_id]["baseArmId"]),
            "arm base declaration mismatch",
        )
        require(
            item.get("modelHashes") == contract["model"]["hashes"],
            "model hash drifted",
        )
        require(
            _finite_number(item.get("probeDurationSeconds"), "probe duration")
            <= contract["maximumProbeMinutes"] * 60,
            "probe exceeds 30 minutes",
        )
        require(item.get("warmupRuns") == 1, "each arm needs one warmup")
        require(item.get("measuredRuns") in {3, 5}, "arm run count is invalid")
        for metric in (
            "errorRate",
            "nonTargetErrorRate",
            "targetTermRecall",
            "rtf",
            "peakRssBytes",
            "retainedRssBytes",
            "coldLoadMs",
            "warmLoadMs",
            "p95SegmentLatencyMs",
        ):
            _finite_number(item.get(metric), f"{arm_id}.{metric}")
        require(item.get("cancellationClean") is True, "cancellation left residue")
        require(item.get("temporaryFilesClean") is True, "temporary files left residue")
        require(isinstance(item.get("truncated"), bool), "arm truncation flag is invalid")
        require(
            isinstance(item.get("hallucinated"), bool),
            "arm hallucination flag is invalid",
        )

    promotion = contract["promotion"]
    admissible: list[tuple[float, str, str]] = []
    admitted_ids = {"control"}
    for arm_contract in contract["arms"]:
        arm_id = arm_contract["id"]
        if arm_id not in by_id:
            continue
        arm = by_id[arm_id]
        base_id = arm_contract["baseArmId"]
        if base_id not in admitted_ids or base_id not in by_id:
            continue
        control = by_id[base_id]
        quality_gain = control["errorRate"] - arm["errorRate"]
        recall_gain = (
            (arm["targetTermRecall"] - control["targetTermRecall"])
            / max(control["targetTermRecall"], 1e-9)
        )
        non_target_regression = (
            arm["nonTargetErrorRate"] - control["nonTargetErrorRate"]
        )
        rtf_change = (arm["rtf"] - control["rtf"]) / control["rtf"]
        speed_gain = (control["rtf"] - arm["rtf"]) / control["rtf"]
        quality_arm = (
            quality_gain >= promotion["qualityAbsoluteImprovement"]
            or recall_gain >= promotion["targetTermRelativeRecallImprovement"]
        )
        speed_arm = speed_gain >= promotion["speedRelativeImprovement"]
        if (
            arm["truncated"] is False
            and arm["hallucinated"] is False
            and non_target_regression
            <= promotion["maximumNonTargetErrorRegression"]
            and rtf_change <= promotion["maximumRtfRegression"]
            and (quality_arm or speed_arm)
        ):
            admitted_ids.add(arm_id)
            admissible.append((arm["errorRate"], arm_id, "quality" if quality_arm else "speed"))
    if not admissible:
        return {
            "status": "CONTROL_RETAINED",
            "selectedArm": "control",
            "reason": "no arm met preregistered quality/speed guardrails",
        }
    admissible.sort()
    _, selected, basis = admissible[0]
    return {
        "status": "OPTIMIZATION_ADMITTED",
        "selectedArm": selected,
        "reason": f"{basis} gate passed",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--result", type=Path)
    arguments = parser.parse_args()
    try:
        contract = json.loads(arguments.contract.read_text(encoding="utf-8"))
        validate_contract(contract)
        if arguments.result is None:
            print("PASS: Qwen3 bounded optimization contract is valid")
        else:
            result = json.loads(arguments.result.read_text(encoding="utf-8"))
            print(json.dumps(validate_result(result, contract), sort_keys=True))
    except (OSError, json.JSONDecodeError, Qwen3OptimizationError) as error:
        print(f"FAIL: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
