#!/usr/bin/env python3
"""Derive the frozen Qwen3 optimization pack from the U13 FLEURS fixtures."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "benchmark/desktop/live_caption/live_caption_fixtures.json"
OUTPUT = Path(__file__).with_name("qwen3_optimization_fixtures.json")
REQUIRED_SCENARIOS = (
    "clean_near_field_mandarin",
    "far_field_noisy_meeting",
    "zh_en_code_switch",
    "terminology_numbers",
    "system_microphone_double_talk",
    "non_speech",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    fixtures_by_scenario: dict[str, dict[str, Any]] = {}
    for fixture in source["fixtures"]:
        if (
            fixture.get("fixtureRole") == "held_out"
            and fixture.get("scenario") in REQUIRED_SCENARIOS
        ):
            scenario = fixture["scenario"]
            if scenario in fixtures_by_scenario:
                raise ValueError(f"duplicate held-out fixture: {scenario}")
            fixtures_by_scenario[scenario] = fixture
    if set(fixtures_by_scenario) != set(REQUIRED_SCENARIOS):
        raise ValueError("U13 held-out coverage is incomplete")

    fixtures: list[dict[str, Any]] = []
    for scenario in REQUIRED_SCENARIOS:
        fixture = json.loads(
            json.dumps(fixtures_by_scenario[scenario], ensure_ascii=False)
        )
        fixture["useDisposition"] = "qwen3_single_variable_ranking"
        fixture["licenseOrConsent"] = "CC-BY-4.0_LOCAL_ONLY"
        fixture["redistribution"] = "never_commit_audio"
        fixture["annotations"] = {
            "terminology": [],
            "numericEvents": [],
        }
        if scenario == "terminology_numbers":
            fixture["annotations"] = {
                "terminology": [
                    {"expectedAlternatives": ["戴维营协议"]},
                    {"expectedAlternatives": ["美中关系正常化"]},
                    {"expectedAlternatives": ["伊朗人质危机"]},
                    {"expectedAlternatives": ["苏联入侵阿富汗"]},
                ],
                "numericEvents": [
                    {
                        "expectedLexicalAlternatives": ["1978", "一九七八"],
                        "expectedDisplay": "1978",
                    },
                    {
                        "expectedLexicalAlternatives": ["1979", "一九七九"],
                        "expectedDisplay": "1979",
                    },
                    {
                        "expectedLexicalAlternatives": ["2010", "二零一零"],
                        "expectedDisplay": "2010",
                    },
                    {
                        "expectedLexicalAlternatives": [
                            "1400",
                            "1,400",
                            "一千四百",
                        ],
                        "expectedDisplay": "1,400",
                    },
                    {
                        "expectedLexicalAlternatives": ["2008", "二零零八"],
                        "expectedDisplay": "2008",
                    },
                    {
                        "expectedLexicalAlternatives": ["8%", "百分之八"],
                        "expectedDisplay": "8%",
                    },
                ],
            }
        fixtures.append(fixture)

    output = {
        "schemaVersion": 2,
        "fixtureManifestId": "qwen3-asr-bounded-optimization/macos-m4/fleurs-v1",
        "status": "FROZEN",
        "distributionState": "LOCAL_ONLY",
        "sourceManifest": {
            "path": str(SOURCE.relative_to(ROOT)),
            "sha256": sha256(SOURCE),
        },
        "dataset": source["dataset"],
        "pcmFormat": source["pcmFormat"],
        "requiredHeldOutScenarios": list(REQUIRED_SCENARIOS),
        "fixtures": fixtures,
    }
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"{OUTPUT}: {sha256(OUTPUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
