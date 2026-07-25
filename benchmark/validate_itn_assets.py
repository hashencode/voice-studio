#!/usr/bin/env python3
"""Validate that ITN is either fully evidenced or explicitly fail-closed."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "itn_asset_manifest.json"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ItnValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ItnValidationError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(manifest: dict[str, Any], root: Path = ROOT) -> bool:
    require(manifest.get("schemaVersion") == 1, "schemaVersion must be 1")
    gate = manifest.get("productGate", {})
    require(
        isinstance(gate.get("available"), bool)
        and isinstance(gate.get("verified"), bool),
        "product gate flags must be booleans",
    )
    require(
        not gate["verified"] or gate["available"],
        "verified ITN cannot be unavailable",
    )

    fixture = manifest.get("goldenFixture", {})
    fixture_path = root / str(fixture.get("path", ""))
    require(fixture_path.is_file(), f"missing ITN golden fixture: {fixture_path}")
    expected_hash = str(fixture.get("sha256", ""))
    require(bool(SHA256.fullmatch(expected_hash)), "invalid ITN golden fixture sha256")
    require(sha256(fixture_path) == expected_hash, "ITN golden fixture hash mismatch")
    golden = json.loads(fixture_path.read_text(encoding="utf-8"))
    require(golden.get("schemaVersion") == 1, "ITN golden schemaVersion must be 1")
    cases = golden.get("cases", [])
    require(isinstance(cases, list) and cases, "ITN golden cases are missing")
    transformed = {
        str(case.get("category"))
        for case in cases
        if case.get("transformed") is True
    }
    preserved = {
        str(case.get("category"))
        for case in cases
        if case.get("transformed") is False
        and case.get("input") == case.get("expected")
    }
    require(
        set(fixture.get("requiredTransformCategories", [])) <= transformed,
        "ITN golden fixture is missing a required transform category",
    )
    require(
        set(fixture.get("requiredPreservationCategories", [])) <= preserved,
        "ITN golden fixture is missing a required preservation category",
    )

    asset = manifest.get("asset")
    if gate["verified"]:
        require(isinstance(asset, dict), "verified ITN requires an asset")
        asset_path = root / str(asset.get("path", ""))
        require(asset_path.is_file(), f"verified ITN asset is missing: {asset_path}")
        asset_hash = str(asset.get("sha256", ""))
        require(bool(SHA256.fullmatch(asset_hash)), "verified ITN asset sha256 is invalid")
        require(sha256(asset_path) == asset_hash, "verified ITN asset hash mismatch")
        require(asset_path.stat().st_size == int(asset.get("bytes", -1)), "ITN asset size mismatch")
        license_payload = asset.get("license", {})
        require(license_payload.get("status") == "clear", "verified ITN requires a clear license")
        require(bool(license_payload.get("spdx")), "verified ITN license requires SPDX")
        require(bool(license_payload.get("evidence")), "verified ITN license requires evidence")
        require(
            asset.get("backendContract") == "complete_match_deterministic",
            "verified ITN requires the complete-match deterministic backend",
        )
        require(not gate.get("reason"), "verified ITN cannot retain a blocker reason")
        return True

    require(asset is None, "disabled ITN must not retain an unverified packaged asset")
    require(
        gate.get("reason") == "itn_asset_missing",
        "disabled ITN must use the fail-closed itn_asset_missing reason",
    )
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--require-enabled", action="store_true")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        enabled = validate_manifest(manifest)
    except (ItnValidationError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ITN asset validation failed: {error}")
        return 1
    if args.require_enabled and not enabled:
        print("ITN gate BLOCKED: itn_asset_missing")
        return 2
    print("ITN gate PASS" if enabled else "ITN gate BLOCKED (fail-closed): itn_asset_missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
