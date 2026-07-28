#!/usr/bin/env python3
"""Finalize the frozen U18 SenseVoice optimization decision."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from evaluate_live_caption import (
    ROOT,
    build_optimization_summary,
    build_u13_optimization_control_metrics,
    select_optimization_final_decision,
    sha256,
    validate_fixture_manifest,
    validate_optimization_contract,
)


HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / "evidence/sensevoice-optimization/macos"


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--contract",
        type=Path,
        default=HERE / "sensevoice_optimization_contract.json",
    )
    parser.add_argument(
        "--screening-raw",
        type=Path,
        default=EVIDENCE / "screening-raw.json",
    )
    parser.add_argument(
        "--screening-summary",
        type=Path,
        default=EVIDENCE / "screening-summary.json",
    )
    parser.add_argument(
        "--finalist-raw",
        type=Path,
        default=EVIDENCE / "finalist-raw.json",
    )
    parser.add_argument(
        "--finalist-summary",
        type=Path,
        default=EVIDENCE / "finalist-summary.json",
    )
    parser.add_argument(
        "--u13-raw",
        type=Path,
        default=HERE / "evidence/macos/u13-control-raw-v2.json",
    )
    parser.add_argument(
        "--u13-decision",
        type=Path,
        default=HERE / "evidence/macos/u13-control-decision.json",
    )
    parser.add_argument(
        "--u13-integration-probe",
        type=Path,
        default=HERE / "evidence/macos/u13-flutter-capture-probe.json",
    )
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=EVIDENCE / "u18-decision.json",
    )
    args = parser.parse_args()

    contract = _load(args.contract)
    validate_optimization_contract(contract)
    manifest_path = ROOT / contract["inputs"]["fixtureManifestPath"]
    manifest = _load(manifest_path)
    validate_fixture_manifest(manifest)
    screening_raw = _load(args.screening_raw)
    finalist_raw = _load(args.finalist_raw)
    screening_summary = _load(args.screening_summary)
    finalist_summary = _load(args.finalist_summary)
    rebuilt_screening = build_optimization_summary(
        raw=screening_raw,
        contract=contract,
        manifest=manifest,
        fixture_root=args.fixture_root,
    )
    rebuilt_finalist = build_optimization_summary(
        raw=finalist_raw,
        contract=contract,
        manifest=manifest,
        fixture_root=args.fixture_root,
    )
    if screening_summary != rebuilt_screening:
        raise ValueError("screening summary does not match frozen raw evidence")
    if finalist_summary != rebuilt_finalist:
        raise ValueError("finalist summary does not match frozen raw evidence")
    u13_raw = _load(args.u13_raw)
    u13_decision = _load(args.u13_decision)
    if (
        u13_decision.get("status") != "PASS"
        or u13_decision.get("productDisposition")
        != "U13_CONTROL_ADMITTED_PENDING_U18_OPTIMIZATION_DECISION"
    ):
        raise ValueError("U13 control decision is not admissible")
    control_metrics = build_u13_optimization_control_metrics(
        raw=u13_raw,
        contract=contract,
        manifest=manifest,
        fixture_root=args.fixture_root,
    )
    final_decision = select_optimization_final_decision(
        screening=screening_summary,
        finalist=finalist_summary,
        control=control_metrics,
        contract=contract,
    )
    selected_profile = (
        finalist_summary["arms"][0]["effectiveConfig"]
        if final_decision["status"] == "OPTIMIZATION_ADMITTED"
        else contract["control"]
    )
    decision = {
        "schemaVersion": 1,
        "kind": "sensevoice_live_caption_optimization_decision",
        "contractId": contract["contractId"],
        "status": "PASS",
        "developmentPosture": "DEVELOPMENT_ONLY",
        "target": contract["target"],
        "decision": final_decision,
        "selectedProfile": {
            "id": final_decision["selectedArm"],
            "config": selected_profile,
        },
        "fallbackProfile": {
            "id": "control",
            "config": contract["control"],
        },
        "screeningSelection": screening_summary["selection"],
        "controlMetrics": control_metrics,
        "finalistMetrics": finalist_summary["arms"][0],
        "bindings": {
            "contract": {
                "path": str(args.contract.relative_to(ROOT)),
                "sha256": sha256(args.contract),
            },
            "fixtureManifest": {
                "path": str(manifest_path.relative_to(ROOT)),
                "sha256": sha256(manifest_path),
            },
            "screeningRaw": {
                "path": str(args.screening_raw.relative_to(ROOT)),
                "sha256": sha256(args.screening_raw),
            },
            "screeningSummary": {
                "path": str(args.screening_summary.relative_to(ROOT)),
                "sha256": sha256(args.screening_summary),
            },
            "finalistRaw": {
                "path": str(args.finalist_raw.relative_to(ROOT)),
                "sha256": sha256(args.finalist_raw),
            },
            "finalistSummary": {
                "path": str(args.finalist_summary.relative_to(ROOT)),
                "sha256": sha256(args.finalist_summary),
            },
            "u13Raw": {
                "path": str(args.u13_raw.relative_to(ROOT)),
                "sha256": sha256(args.u13_raw),
            },
            "u13Decision": {
                "path": str(args.u13_decision.relative_to(ROOT)),
                "sha256": sha256(args.u13_decision),
            },
            "u13IntegrationProbe": {
                "path": str(args.u13_integration_probe.relative_to(ROOT)),
                "sha256": sha256(args.u13_integration_probe),
            },
        },
        "privacy": {
            "audioPublished": False,
            "modelFilesPublished": False,
            "absolutePathsPublished": False,
            "credentialsPublished": False,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(decision, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, args.output)
    print(
        json.dumps(
            {
                "status": decision["status"],
                "decision": final_decision["status"],
                "selectedArm": final_decision["selectedArm"],
                "output": str(args.output),
                "sha256": sha256(args.output),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
