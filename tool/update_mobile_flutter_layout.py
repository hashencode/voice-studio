#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess


ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/product/mobile-flutter-layout.json"
ELECTRON_IDENTITY_PATHS = (
    "apps/desktop-electron/forge.config.ts",
    "apps/desktop-electron/package.json",
    "apps/desktop-electron/resources/worker/manifest.json",
    "apps/desktop-electron/src/main/profile/audio_profile.ts",
    "apps/desktop-electron/src/main/profile/profile_paths.ts",
    "apps/desktop-electron/src/main/storage/audio_database.ts",
    "apps/desktop-electron/src/main/storage/audio_schema.ts",
)


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tracked_mobile_paths(root: pathlib.Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "apps/mobile-flutter"],
        check=True,
        capture_output=True,
        text=True,
    )
    return sorted(line for line in result.stdout.splitlines() if line)


def generated_manifest(root: pathlib.Path = ROOT) -> str:
    payload = json.loads((root / MANIFEST.relative_to(ROOT)).read_text(encoding="utf-8"))
    moved_paths = _tracked_mobile_paths(root)
    payload["schema"] = "voice2text-mobile-flutter-layout/v2"
    payload["movedTrackedPaths"] = moved_paths
    payload["movedTrackedFileCount"] = len(moved_paths)

    mobile_identity = payload["mobileIdentity"]
    for key in ("androidManifest", "androidBuild", "sherpaAar"):
        entry = mobile_identity[key]
        entry["sha256"] = _sha256(root / entry["path"])

    payload["electronIdentity"] = {
        "productName": "Voice2Text",
        "bundleId": "com.voice2text.desktop",
        "profileSchema": "voice2text-electron/v2",
        "databaseFileName": "audio.sqlite3",
        "databaseUserVersion": 1,
        "files": [
            {"path": relative, "sha256": _sha256(root / relative)}
            for relative in ELECTRON_IDENTITY_PATHS
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    generated = generated_manifest()
    if options.check:
        if MANIFEST.read_text(encoding="utf-8") != generated:
            raise SystemExit(
                "mobile Flutter layout metadata is stale; run "
                "python3 tool/update_mobile_flutter_layout.py"
            )
        print("Mobile Flutter layout metadata is current.")
        return 0
    MANIFEST.write_text(generated, encoding="utf-8")
    print(f"Updated {MANIFEST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
