#!/usr/bin/env python3
"""Derive U18 annotations without mutating the frozen U13 fixture manifest."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).with_name("live_caption_fixtures.json")
OUTPUT = Path(__file__).with_name("sensevoice_optimization_fixtures.json")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def numeric(
    lexical: list[str],
    display: str,
) -> dict[str, Any]:
    return {
        "expectedLexicalAlternatives": lexical,
        "expectedDisplay": display,
    }


def main() -> int:
    manifest = json.loads(SOURCE.read_text(encoding="utf-8"))
    for fixture in manifest["fixtures"]:
        scenario = fixture["scenario"]
        role = fixture["fixtureRole"]
        fixture["optimizationAnnotations"] = {
            "terminology": [],
            "numericEvents": [],
            "codeSwitch": scenario == "zh_en_code_switch",
        }
        if scenario != "terminology_numbers":
            continue
        if role == "development":
            fixture["optimizationAnnotations"] = {
                "terminology": [
                    {"expectedAlternatives": ["澳大利亚"]},
                    {
                        "expectedAlternatives": [
                            "大卫克洛克埃伦斯特拉尔",
                            "大卫·克洛克·埃伦斯特拉尔",
                        ]
                    },
                    {"expectedAlternatives": ["吉尼斯世界纪录大全"]},
                    {"expectedAlternatives": ["英联邦运动会"]},
                ],
                "numericEvents": [
                    numeric(["2010", "二零一零"], "2010"),
                    numeric(["1400", "1,400", "一千四百"], "1,400"),
                    numeric(["2008", "二零零八"], "2008"),
                    numeric(["8%", "百分之八"], "8%"),
                    numeric(["2000", "二零零零"], "2000"),
                    numeric(["1000", "一千"], "1000"),
                    numeric(["100", "一百"], "100"),
                    numeric(["200", "二百", "两百"], "200"),
                ],
                "codeSwitch": False,
            }
        elif role == "held_out":
            fixture["optimizationAnnotations"] = {
                "terminology": [
                    {"expectedAlternatives": ["戴维营协议"]},
                    {"expectedAlternatives": ["美中关系正常化"]},
                    {"expectedAlternatives": ["伊朗人质危机"]},
                    {"expectedAlternatives": ["苏联入侵阿富汗"]},
                ],
                "numericEvents": [
                    numeric(["1978", "一九七八"], "1978"),
                    numeric(["1979", "一九七九"], "1979"),
                    numeric(["2010", "二零一零"], "2010"),
                    numeric(["1400", "1,400", "一千四百"], "1,400"),
                    numeric(["2008", "二零零八"], "2008"),
                    numeric(["8%", "百分之八"], "8%"),
                ],
                "codeSwitch": False,
            }
    manifest["fixtureManifestId"] = (
        "sensevoice-live-caption-optimization/macos-m4/fleurs-v1"
    )
    manifest["sourceManifest"] = {
        "path": str(SOURCE.relative_to(ROOT)),
        "sha256": sha256(SOURCE),
    }
    OUTPUT.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"{OUTPUT}: {sha256(OUTPUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
