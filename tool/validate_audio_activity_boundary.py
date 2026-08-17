#!/usr/bin/env python3

from __future__ import annotations

import json
import pathlib
import re
import sys
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/architecture/audio-activity-source-boundary.json"
MEETING_PATTERN = re.compile(
    r"(?:\bmeetings?\b|meeting_|Meeting[A-Z]|meeting-[a-z])"
)
TEXT_SUFFIXES = {
    ".dart",
    ".gradle",
    ".json",
    ".kt",
    ".kts",
    ".lock",
    ".md",
    ".properties",
    ".py",
    ".sh",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
IGNORED_DIRECTORIES = {
    ".dart_tool",
    ".git",
    ".openai",
    "build",
    "node_modules",
}


class BoundaryValidationError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BoundaryValidationError(message)


def _load_manifest(path: pathlib.Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    _require(isinstance(raw, dict), "Audio activity boundary must be an object")
    expected = {
        "schema",
        "canonicalActivityNoun",
        "freshAudioBoundaries",
        "activeMeetingRenameInventory",
        "historicalMeetingAllowlist",
        "legacyRejectionAllowlist",
        "protocol",
        "storage",
    }
    _require(set(raw) == expected, "Audio activity boundary fields drifted")
    return raw


def _path_entries(values: Any, label: str, *, field: str) -> list[str]:
    _require(isinstance(values, list) and values, f"{label} must be non-empty")
    paths: list[str] = []
    for value in values:
        _require(isinstance(value, dict), f"{label} entry must be an object")
        _require(field in value, f"{label} entry is missing {field}")
        path = value.get("path")
        _require(isinstance(path, str) and path, f"{label} path is invalid")
        paths.append(path)
    _require(len(paths) == len(set(paths)), f"{label} contains duplicate paths")
    return paths


def _is_inside(relative_path: str, prefix: str) -> bool:
    return relative_path == prefix or relative_path.startswith(f"{prefix}/")


def _meeting_paths(root: pathlib.Path) -> list[str]:
    matches: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file() or any(
            part in IGNORED_DIRECTORIES for part in path.relative_to(root).parts
        ):
            continue
        if path.suffix not in TEXT_SUFFIXES and path.name not in {
            "README",
            "pubspec.yaml",
        }:
            continue
        relative = path.relative_to(root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if MEETING_PATTERN.search(relative) or MEETING_PATTERN.search(content):
            matches.append(relative)
    return sorted(matches)


def find_unclassified_meeting_paths(
    root: pathlib.Path,
    *,
    active: list[str],
    historical: list[str],
    rejection: list[str],
) -> list[str]:
    return [
        path
        for path in _meeting_paths(root)
        if path not in rejection
        and not any(_is_inside(path, prefix) for prefix in historical)
        and not any(_is_inside(path, prefix) for prefix in active)
    ]


def validate(root: pathlib.Path = ROOT, manifest_path: pathlib.Path = MANIFEST) -> None:
    manifest = _load_manifest(manifest_path)
    _require(
        manifest["schema"] == "voice2text-audio-activity-source-boundary/v1",
        "Audio activity boundary schema is invalid",
    )
    _require(
        manifest["canonicalActivityNoun"] == "Audio",
        "Audio must be the canonical activity noun",
    )
    active = _path_entries(
        manifest["activeMeetingRenameInventory"],
        "active Meeting rename inventory",
        field="owner",
    )
    historical = _path_entries(
        manifest["historicalMeetingAllowlist"],
        "historical Meeting allowlist",
        field="reason",
    )
    rejection = manifest["legacyRejectionAllowlist"]
    fresh = manifest["freshAudioBoundaries"]
    _require(
        isinstance(rejection, list) and all(isinstance(item, str) for item in rejection),
        "legacy rejection allowlist is invalid",
    )
    _require(
        isinstance(fresh, list) and all(isinstance(item, str) for item in fresh),
        "fresh Audio boundaries are invalid",
    )
    for relative in [*active, *historical, *rejection, *fresh]:
        _require((root / relative).exists(), f"bound path does not exist: {relative}")
    unclassified = find_unclassified_meeting_paths(
        root,
        active=active,
        historical=historical,
        rejection=rejection,
    )
    _require(
        not unclassified,
        "Meeting paths are outside the rename inventory/allowlists: "
        + ", ".join(unclassified),
    )
    for relative in fresh:
        path = root / relative
        candidates = [path] if path.is_file() else list(path.rglob("*"))
        for candidate in candidates:
            if not candidate.is_file() or candidate.suffix not in TEXT_SUFFIXES:
                continue
            content = candidate.read_text(encoding="utf-8")
            _require(
                not MEETING_PATTERN.search(candidate.relative_to(root).as_posix())
                and not MEETING_PATTERN.search(content),
                f"fresh Audio boundary contains Meeting vocabulary: {candidate}",
            )

    protocol = manifest["protocol"]
    _require(isinstance(protocol, dict), "protocol binding is invalid")
    _require(protocol.get("schema") == "companion-audio-transfer/v2", "protocol schema drift")
    _require(protocol.get("capability") == "audio-transfer/v2", "protocol capability drift")
    _require(protocol.get("snapshotVersion") == 2, "protocol snapshot version drift")
    _require(protocol.get("legacySchema") == "companion-media-transfer/v1", "legacy rejection schema drift")
    for authority in (protocol.get("dartAuthority"), protocol.get("electronAuthority")):
        _require(isinstance(authority, str), "protocol authority path is invalid")
        content = (root / authority).read_text(encoding="utf-8")
        _require(protocol["schema"] in content, f"protocol schema missing from {authority}")
        _require(protocol["capability"] in content, f"protocol capability missing from {authority}")

    storage = manifest["storage"]
    _require(isinstance(storage, dict), "storage binding is invalid")
    _require(storage.get("profileVersion") == "v2", "Audio profile version drift")
    _require(storage.get("databaseFileName") == "audio.sqlite3", "Audio database name drift")
    _require(storage.get("schemaVersion") == 1, "Audio schema version drift")
    _require(storage.get("migrationSupported") is False, "Audio migration must remain disabled")
    for key in ("electronSchemaAuthority", "electronProfileAuthority", "dartAuthority"):
        authority = storage.get(key)
        _require(isinstance(authority, str) and (root / authority).is_file(), f"storage authority is invalid: {key}")


def main() -> int:
    try:
        validate()
    except (BoundaryValidationError, OSError, ValueError) as error:
        print(f"Audio activity boundary validation failed: {error}", file=sys.stderr)
        return 1
    print("Audio activity boundary validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
