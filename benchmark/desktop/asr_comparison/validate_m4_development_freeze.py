#!/usr/bin/env python3
"""Validate the privacy-safe M4 development freeze before held-out decode."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")


class FreezeError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FreezeError(message)


def validate(document: dict[str, Any]) -> None:
    require(document.get("schemaVersion") == 1, "schema version must be 1")
    require(document.get("kind") == "m4_asr_development_freeze", "kind is invalid")
    require(
        document.get("measurementContractRevision") == "m4-zh-en-measurement-v1",
        "measurement contract revision is invalid",
    )
    profile = document.get("resourceProfile")
    require(isinstance(profile, dict), "resource profile is required")
    expected_profile = {
        "provider": "cpu",
        "numThreads": 2,
        "concurrency": 1,
        "segmentDurationSeconds": 15,
        "warmupRuns": 1,
        "measuredRuns": 5,
        "scheduleSeed": 20260726,
    }
    require(profile == expected_profile, "resource profile drifted")
    gates = document.get("hardGates")
    require(isinstance(gates, dict), "hard gates are required")
    require(gates.get("maximumCer") == 0.35, "CER gate drifted")
    require(gates.get("maximumWer") == 0.35, "WER gate drifted")
    require(gates.get("maximumRtf") == 0.5, "RTF gate drifted")
    require(
        gates.get("maximumAbsolutePeakRssBytes") == 2 * 1024**3,
        "memory gate drifted",
    )
    for section in ("bindings", "corpusBindings", "developmentEvidence"):
        values = document.get(section)
        require(isinstance(values, dict) and values, f"{section} is required")
        require(
            all(isinstance(value, str) and SHA256.fullmatch(value) for value in values.values()),
            f"{section} must contain SHA-256 values",
        )
    lanes = document.get("languageLanes")
    require(isinstance(lanes, dict) and set(lanes) == {"zh", "en"}, "lanes are invalid")
    for lane_id, metric_name in (("zh", "cer"), ("en", "wer")):
        lane = lanes[lane_id]
        require(lane.get("lexicalMetric") == metric_name, "lexical metric drifted")
        finalists = lane.get("finalistCandidateIds")
        results = lane.get("developmentResults")
        require(
            isinstance(finalists, list) and len(finalists) == 2 and len(set(finalists)) == 2,
            "each lane must freeze exactly two finalists",
        )
        require(isinstance(results, list) and results, "development results are required")
        by_id = {item.get("candidateId"): item for item in results}
        require(set(finalists) <= set(by_id), "finalist result is missing")
        for item in results:
            metric = item.get("metric")
            require(
                isinstance(metric, (int, float)) and math.isfinite(metric),
                "development metric must be finite",
            )
            disposition = item.get("disposition")
            if item["candidateId"] in finalists:
                require(disposition == "FINALIST", "finalist disposition drifted")
            if disposition == "REJECTED_QUALITY_GATE":
                require(metric > gates[f"maximum{metric_name.title()}"], "quality rejection is invalid")
    privacy = document.get("privacy")
    require(
        isinstance(privacy, dict)
        and privacy
        and all(value is False for value in privacy.values()),
        "privacy publication flags must remain false",
    )
    serialized = json.dumps(document, ensure_ascii=False)
    require("/Users/" not in serialized, "absolute user path is forbidden")


def main() -> int:
    path = Path(__file__).with_name("m4_development_freeze.json")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        validate(document)
    except (OSError, json.JSONDecodeError, FreezeError) as error:
        print(f"M4 development freeze: FAIL: {error}")
        return 1
    print("M4 development freeze: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
