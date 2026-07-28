#!/usr/bin/env python3
"""Finalize U17 raw lineage, summary, and target-bound decision artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from evaluate_qwen3_optimization import validate_result


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = Path(__file__).with_name("qwen3_optimization_contract.json")
DEFAULT_EVIDENCE_ROOT = (
    Path(__file__).parent / "evidence/qwen3-optimization/macos"
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def profiles(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    values = {"control": dict(contract["control"])}
    for arm in contract["arms"]:
        value = dict(values[arm["baseArmId"]])
        value[arm["variable"]] = arm["value"]
        if arm["variable"] == "runtime":
            value["runtimeSha256"] = arm["runtimeSha256"]
        values[arm["id"]] = value
    return values


def raw_manifest(
    *,
    contract_sha256: str,
    evidence_root: Path,
) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for run_path in sorted((evidence_root / "runs").glob("asr2-*.json")):
        run = json.loads(run_path.read_text(encoding="utf-8"))
        if run.get("bindings", {}).get("contractSha256") != contract_sha256:
            continue
        run_id = run["runId"]
        raw_path = evidence_root / "raw" / f"{run_id}.json"
        if not raw_path.is_file():
            raise ValueError(f"raw worker result is missing for {run_id}")
        raw_document_sha256 = sha256(raw_path)
        runs.append(
            {
                "runId": run_id,
                "profileId": run["profileId"],
                "scenario": run["scenario"],
                "scheduleOrder": run["scheduleOrder"],
                "warmup": run["warmup"],
                "run": {
                    "path": relative(run_path),
                    "sha256": sha256(run_path),
                },
                "workerOutput": {
                    "path": relative(raw_path),
                    "documentSha256": raw_document_sha256,
                    "semanticResultSha256": run["rawOutputSha256"],
                },
            }
        )
    runs.sort(key=lambda item: (item["scheduleOrder"], item["runId"]))
    if not runs:
        raise ValueError("no current-contract U17 runs were found")
    schedule = [item["scheduleOrder"] for item in runs]
    if len(schedule) != len(set(schedule)):
        raise ValueError("U17 schedule order is not unique")
    temporary = evidence_root / "temporary"
    if temporary.is_dir() and any(temporary.iterdir()):
        raise ValueError("U17 temporary artifacts remain")
    return {
        "schemaVersion": 1,
        "kind": "qwen3_optimization_raw_manifest",
        "contractId": "qwen3-asr-bounded-optimization/macos-m4/v1",
        "status": "COMPLETE",
        "developmentPosture": "DEVELOPMENT_ONLY",
        "contractSha256": contract_sha256,
        "runCount": len(runs),
        "runs": runs,
        "temporaryArtifactsClean": True,
    }


def finalize(
    *,
    contract_path: Path,
    matrix_path: Path,
    evidence_root: Path,
) -> dict[str, Any]:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    decision_preview = validate_result(matrix, contract)
    contract_hash = sha256(contract_path)
    matrix_hash = sha256(matrix_path)

    raw_path = evidence_root / "u17-raw-manifest.json"
    summary_path = evidence_root / "u17-summary.json"
    decision_path = evidence_root / "u17-decision.json"

    raw = raw_manifest(
        contract_sha256=contract_hash,
        evidence_root=evidence_root,
    )
    write_json(raw_path, raw)
    raw_hash = sha256(raw_path)

    summary = {
        "schemaVersion": 1,
        "kind": "qwen3_optimization_summary",
        "contractId": contract["contractId"],
        "status": "COMPLETE",
        "developmentPosture": contract["developmentPosture"],
        "target": matrix["target"],
        "bindings": {
            "contract": {
                "path": relative(contract_path),
                "sha256": contract_hash,
            },
            "fixtureManifest": {
                "path": contract["inputs"]["fixtureManifestPath"],
                "sha256": contract["inputs"]["fixtureManifestSha256"],
            },
            "scoringContract": {
                "path": contract["inputs"]["scoringContractPath"],
                "sha256": contract["inputs"]["scoringContractSha256"],
            },
            "rawManifest": {
                "path": relative(raw_path),
                "sha256": raw_hash,
            },
            "matrix": {
                "path": relative(matrix_path),
                "sha256": matrix_hash,
            },
        },
        "arms": matrix["arms"],
        "decisionPreview": decision_preview,
    }
    write_json(summary_path, summary)
    summary_hash = sha256(summary_path)

    selected_arm = decision_preview["selectedArm"]
    selected_profile = profiles(contract)[selected_arm]
    decision = {
        "schemaVersion": 1,
        "kind": "qwen3_optimization_decision",
        "contractId": contract["contractId"],
        "status": "PASS",
        "developmentPosture": contract["developmentPosture"],
        "target": matrix["target"],
        "decision": decision_preview,
        "selectedProfile": {
            "id": selected_arm,
            "config": selected_profile,
        },
        "fallbackProfile": {
            "id": "control",
            "config": contract["control"],
        },
        "bindings": {
            **summary["bindings"],
            "summary": {
                "path": relative(summary_path),
                "sha256": summary_hash,
            },
        },
    }
    write_json(decision_path, decision)
    return {
        "status": "PASS",
        "selectedArm": selected_arm,
        "rawManifestSha256": raw_hash,
        "summarySha256": summary_hash,
        "decisionSha256": sha256(decision_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument(
        "--matrix",
        type=Path,
        default=DEFAULT_EVIDENCE_ROOT / "matrix.json",
    )
    parser.add_argument(
        "--evidence-root",
        type=Path,
        default=DEFAULT_EVIDENCE_ROOT,
    )
    arguments = parser.parse_args()
    try:
        result = finalize(
            contract_path=arguments.contract.resolve(),
            matrix_path=arguments.matrix.resolve(),
            evidence_root=arguments.evidence_root.resolve(),
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
