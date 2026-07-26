#!/usr/bin/env python3
"""Ensure the human selection record agrees with the machine decision."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def validate(registry: dict, document: str) -> None:
    decision = registry.get("machineDecision")
    if not isinstance(decision, dict):
        raise ValueError("machine decision missing")
    required = {
        registry.get("decisionId"),
        decision.get("status"),
        decision.get("selectedRuntime"),
        decision.get("selectedBoundary"),
        "null" if decision.get("sidecarWinner") is None else decision["sidecarWinner"],
        *decision.get("winners", {}).values(),
    }
    candidates = registry.get("candidates", [])
    for candidate in candidates:
        required.update(candidate.get("failedSelectionGates", []))
        required.update(candidate.get("hardFailures", []))
    missing = sorted(
        marker for marker in required if not isinstance(marker, str) or marker not in document
    )
    if missing:
        raise ValueError(f"selection document is missing machine markers: {missing}")
    if "Whisper" in document or "whisper" in document:
        raise ValueError("selection document reintroduces an excluded engine")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--document", type=Path, required=True)
    args = parser.parse_args()
    try:
        validate(
            json.loads(args.candidates.read_text()),
            args.document.read_text(),
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"macOS engine selection invalid: {error}")
        return 1
    print("macOS engine selection: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
