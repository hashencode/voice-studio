#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / "docs/product/mobile-flutter-layout.json"
EXPECTED_LEGACY_ROOTS = {
    ".metadata",
    "android",
    "assets",
    "integration_test",
    "lib",
    "test",
}
EXPECTED_ELECTRON_IDENTITY_PATHS = {
    "apps/desktop-electron/forge.config.ts",
    "apps/desktop-electron/package.json",
    "apps/desktop-electron/assets/processing/frozen_sensevoice_macos_arm64.lock.json",
    "apps/desktop-electron/src/main/profile/audio_profile.ts",
    "apps/desktop-electron/src/main/profile/profile_paths.ts",
    "apps/desktop-electron/src/main/storage/audio_database.ts",
    "apps/desktop-electron/src/main/storage/audio_schema.ts",
}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _mapping(value: Any, name: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{name} must be an object")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tracked_mobile_paths(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "apps/mobile-flutter"],
        check=True,
        capture_output=True,
        text=True,
    )
    return sorted(line for line in result.stdout.splitlines() if line)


def _safe_file(root: Path, entry: dict[str, Any], name: str) -> Path:
    relative = entry.get("path")
    _require(isinstance(relative, str) and relative, f"{name}.path invalid")
    path = Path(relative)
    _require(not path.is_absolute() and ".." not in path.parts, f"{name}.path unsafe")
    target = root / path
    _require(target.is_file() and not target.is_symlink(), f"{name}.path missing")
    expected = entry.get("sha256")
    _require(isinstance(expected, str) and len(expected) == 64, f"{name}.sha256 invalid")
    _require(_sha256(target) == expected, f"{name} hash drift")
    return target


def validate_mobile_layout(
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    root: Path = ROOT,
) -> dict[str, Any]:
    payload = _mapping(json.loads(manifest_path.read_text(encoding="utf-8")), "manifest")
    _require(payload.get("schema") == "voice2text-mobile-flutter-layout/v2", "schema invalid")
    _require(payload.get("status") == "PASS", "layout status must be PASS")
    _require(payload.get("mobileRoot") == "apps/mobile-flutter", "mobile root changed")
    _require(set(payload.get("legacyRootPaths", [])) == EXPECTED_LEGACY_ROOTS, "legacy roots changed")
    moved_paths = payload.get("movedTrackedPaths")
    _require(isinstance(moved_paths, list), "moved tracked paths must be an array")
    _require(
        all(isinstance(path, str) for path in moved_paths)
        and moved_paths == sorted(set(moved_paths)),
        "moved tracked paths must be unique and sorted",
    )
    _require(len(moved_paths) == payload.get("movedTrackedFileCount"), "tracked move count changed")
    _require(moved_paths == _tracked_mobile_paths(root), "moved tracked paths drift")
    for relative in moved_paths:
        _require(relative.startswith("apps/mobile-flutter/"), "moved tracked path escaped mobile root")
        target = root / relative
        _require(target.is_file() and not target.is_symlink(), f"moved tracked path missing: {relative}")

    for relative in EXPECTED_LEGACY_ROOTS:
        _require(not (root / relative).exists(), f"legacy root still exists: {relative}")

    workspace = _mapping(payload.get("workspace"), "workspace")
    root_pubspec = (root / "pubspec.yaml").read_text(encoding="utf-8")
    mobile_pubspec = (root / "apps/mobile-flutter/pubspec.yaml").read_text(encoding="utf-8")
    _require(f"name: {workspace['rootPackage']}" in root_pubspec, "root package identity drift")
    _require("  - apps/mobile-flutter" in root_pubspec, "mobile workspace member missing")
    _require("sdk: flutter" not in root_pubspec and "version:" not in root_pubspec, "root remains an app")
    _require(f"name: {workspace['mobilePackage']}" in mobile_pubspec, "mobile package identity drift")
    _require(workspace.get("mobileVersionAtRelocation") == "1.0.1+2", "relocation version evidence drift")
    _require("resolution: workspace" in mobile_pubspec, "mobile workspace resolution missing")
    _require((root / workspace["lockfile"]).is_file(), "workspace lockfile missing")
    _require(not (root / "apps/mobile-flutter/pubspec.lock").exists(), "member lockfile must not exist")

    mobile = _mapping(payload.get("mobileIdentity"), "mobileIdentity")
    manifest = _safe_file(root, _mapping(mobile.get("androidManifest"), "androidManifest"), "androidManifest")
    build = _safe_file(root, _mapping(mobile.get("androidBuild"), "androidBuild"), "androidBuild")
    _safe_file(root, _mapping(mobile.get("sherpaAar"), "sherpaAar"), "sherpaAar")
    manifest_text = manifest.read_text(encoding="utf-8")
    build_text = build.read_text(encoding="utf-8")
    _require('android:authorities="${applicationId}.fileprovider"' in manifest_text, "Android provider identity drift")
    _require('android:name="android.intent.action.SEND"' in manifest_text, "Android share action drift")
    _require(f'namespace = "{mobile["namespace"]}"' in build_text, "Android namespace drift")
    _require(f'?: "{mobile["applicationId"]}"' in build_text, "Android applicationId drift")

    electron = _mapping(payload.get("electronIdentity"), "electronIdentity")
    electron_files = electron.get("files")
    _require(isinstance(electron_files, list), "electron.files must be an array")
    electron_entries = [
        _mapping(raw, f"electron.files[{index}]") for index, raw in enumerate(electron_files)
    ]
    _require(
        {entry.get("path") for entry in electron_entries} == EXPECTED_ELECTRON_IDENTITY_PATHS
        and len(electron_entries) == len(EXPECTED_ELECTRON_IDENTITY_PATHS),
        "Electron identity file set drift",
    )
    for index, entry in enumerate(electron_entries):
        _safe_file(root, entry, f"electron.files[{index}]")
    package_text = (root / "apps/desktop-electron/package.json").read_text(encoding="utf-8")
    forge_text = (root / "apps/desktop-electron/forge.config.ts").read_text(encoding="utf-8")
    profile_text = (root / "apps/desktop-electron/src/main/profile/profile_paths.ts").read_text(encoding="utf-8")
    database_text = (root / "apps/desktop-electron/src/main/storage/audio_database.ts").read_text(encoding="utf-8")
    schema_text = (root / "apps/desktop-electron/src/main/storage/audio_schema.ts").read_text(encoding="utf-8")
    _require(f'"productName": "{electron["productName"]}"' in package_text, "Electron product drift")
    _require(f'appBundleId: "{electron["bundleId"]}"' in forge_text, "Electron bundle drift")
    profile_parts = electron["profileSchema"].split("/")
    _require(
        len(profile_parts) == 2
        and f'"{profile_parts[0]}"' in profile_text
        and f'"{profile_parts[1]}"' in profile_text,
        "Electron profile schema drift",
    )
    _require(
        f'"{electron["databaseFileName"]}"' in profile_text,
        "Audio database filename drift",
    )
    _require(
        f'export const AUDIO_SCHEMA_VERSION = {electron["databaseUserVersion"]}' in schema_text
        and "PRAGMA user_version = ${AUDIO_SCHEMA_VERSION}" in database_text,
        "DB version drift",
    )

    scope = _mapping(payload.get("platformScope"), "platformScope")
    _require(scope == {
        "macosDesktop": "SUPPORTED",
        "windowsDesktop": "DEFERRED_OUT_OF_CURRENT_SCOPE",
        "mobileFlutter": "SUPPORTED",
    }, "platform scope drift")
    return {
        "status": payload["status"],
        "mobileRoot": payload["mobileRoot"],
        "movedTrackedFileCount": payload["movedTrackedFileCount"],
        "windowsDesktop": scope["windowsDesktop"],
    }


def main() -> int:
    print(json.dumps(validate_mobile_layout(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
