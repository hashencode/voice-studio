#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def validate(evidence_path: Path, export_path: Path) -> None:
    evidence = json.loads(evidence_path.read_text())
    if evidence.get("schemaVersion") != 1:
        raise ValueError("unsupported vertical-slice schema")
    if evidence.get("source") != "local_private_file":
        raise ValueError("vertical slice must start from a local private file")
    if evidence.get("cloudProvidersInvoked") != []:
        raise ValueError("vertical slice invoked a cloud provider")
    if evidence.get("aiFeaturesInvoked") != []:
        raise ValueError("vertical slice invoked an AI feature")
    if evidence.get("reviewState") != "manual_correction_available":
        raise ValueError("manual correction is unavailable")
    if not isinstance(evidence.get("reviewRevisionCount"), int):
        raise ValueError("review revision count is missing")
    if evidence.get("exportFormat") != "webvtt":
        raise ValueError("non-AI WebVTT export is missing")
    if evidence.get("complete") is not True or evidence.get("segmentCount", 0) <= 0:
        raise ValueError("vertical slice is incomplete")
    assignments = set(evidence.get("speakerAssignments") or [])
    if not assignments or not assignments <= {"anonymous", "overlap", "unknown"}:
        raise ValueError("speaker assignments are not anonymous")
    actual = hashlib.sha256(export_path.read_bytes()).hexdigest()
    if evidence.get("exportSha256") != actual:
        raise ValueError("export hash mismatch")
    if not export_path.read_text().startswith("WEBVTT\n"):
        raise ValueError("export is not WebVTT")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--export", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate(args.evidence, args.export)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"offline vertical slice invalid: {error}")
        return 1
    print("offline vertical slice: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
