#!/usr/bin/env python3

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/product/audio-sidebar-workstation.json"


class AudioSidebarValidationError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AudioSidebarValidationError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _exact(value: dict[str, Any], fields: set[str], label: str) -> None:
    _require(set(value) == fields, f"{label} fields drifted")


def validate(
    root: pathlib.Path = ROOT,
    manifest_path: pathlib.Path = MANIFEST,
) -> None:
    manifest = _mapping(
        json.loads(manifest_path.read_text(encoding="utf-8")), "manifest"
    )
    _exact(
        manifest,
        {
            "schema",
            "status",
            "activityNoun",
            "navigation",
            "contextPanes",
            "workspaces",
            "storage",
            "protocol",
            "releaseCandidate",
            "historicalArtifacts",
            "authorities",
        },
        "manifest",
    )
    _require(
        manifest["schema"] == "voice2text-audio-sidebar-workstation/v1",
        "manifest schema drifted",
    )
    _require(manifest["activityNoun"] == "Audio", "Audio noun drifted")

    navigation = _mapping(manifest["navigation"], "navigation")
    _exact(navigation, {"rail", "legacyRoutesNormalizeTo"}, "navigation")
    _require(
        navigation["rail"]
        == [
            {"id": "audio", "label": "音频"},
            {"id": "companion", "label": "互联"},
            {"id": "settings", "label": "设置"},
        ],
        "rail must contain exactly 音频 / 互联 / 设置 in order",
    )
    _require(
        navigation["legacyRoutesNormalizeTo"] == "audio",
        "legacy routes must normalize to Audio",
    )

    panes = _mapping(manifest["contextPanes"], "context panes")
    _require(panes.get("owners") == ["audio", "companion"], "pane owners drifted")
    _require(panes.get("preferencesAreIndependent") is True, "pane preferences must be independent")
    _require(panes.get("resizeWritesPreference") is False, "resize must not write pane preferences")
    _require(panes.get("narrowPresentation") == "non-modal-drawer", "narrow pane must be non-modal")
    _require(panes.get("verifiedWidthPx") == 880, "narrow verification width drifted")

    workspaces = _mapping(manifest["workspaces"], "workspaces")
    _require(workspaces.get("singleMeaningfulHeading") is True, "one-heading contract is required")
    _require(
        set(workspaces.get("audioOwns", []))
        == {
            "record",
            "import",
            "search",
            "list",
            "detail",
            "processing",
            "playback",
            "editing",
            "intelligence",
            "export",
        },
        "Audio workspace ownership drifted",
    )
    _require(workspaces.get("standaloneTaskRoute") is False, "standalone task route returned")
    _require(workspaces.get("companionSelectionConnects") is False, "device selection must not connect")
    _require(workspaces.get("companionAvailabilityFallback") == "unknown", "availability must remain truthful")

    storage = _mapping(manifest["storage"], "storage")
    _require(storage.get("profile") == "voice2text-electron/v2", "profile drifted")
    _require(storage.get("database") == "audio.sqlite3", "database name drifted")
    _require(storage.get("schemaVersion") == 1, "database schema drifted")
    _require(storage.get("migrationSupported") is False, "migration must remain disabled")
    _require(
        storage.get("legacyAction") == "timestamped-archive-before-fresh-open",
        "legacy database handling drifted",
    )

    protocol = _mapping(manifest["protocol"], "protocol")
    _require(protocol.get("schema") == "companion-audio-transfer/v2", "protocol schema drifted")
    _require(protocol.get("capability") == "audio-transfer/v2", "protocol capability drifted")
    _require(protocol.get("snapshotVersion") == 2, "protocol snapshot drifted")
    _require(protocol.get("legacyRejectedBeforeMutation") is True, "legacy protocol must reject before mutation")

    candidate = _mapping(manifest["releaseCandidate"], "release candidate")
    _exact(
        candidate,
        {
            "status",
            "sourceRevision",
            "packageManifestSha256",
            "automatedReceipt",
            "manualReceipt",
            "finalizeRebuilds",
        },
        "release candidate",
    )
    _require(candidate["finalizeRebuilds"] is False, "finalize must never rebuild")
    if candidate["status"] == "PENDING_U6_STABLE_CANDIDATE":
        _require(
            manifest["status"] == "DEVELOPMENT_COMPLETE_RELEASE_VALIDATION_PENDING",
            "pending candidate must not claim release PASS",
        )
        for field in (
            "sourceRevision",
            "packageManifestSha256",
            "automatedReceipt",
            "manualReceipt",
        ):
            _require(candidate[field] is None, f"pending candidate must not bind {field}")
    else:
        raise AudioSidebarValidationError(
            "release candidate status is unsupported until the U6 validator is installed"
        )

    historical = manifest["historicalArtifacts"]
    _require(isinstance(historical, list) and historical, "historical artifacts are required")
    paths: list[str] = []
    for item in historical:
        entry = _mapping(item, "historical artifact")
        _exact(entry, {"path", "classification"}, "historical artifact")
        path = entry.get("path")
        classification = entry.get("classification")
        _require(isinstance(path, str) and (root / path).exists(), f"historical artifact is missing: {path}")
        _require(
            isinstance(classification, str)
            and ("HISTORICAL" in classification or "IMMUTABLE" in classification),
            f"historical artifact is not classified: {path}",
        )
        paths.append(path)
    _require(len(paths) == len(set(paths)), "historical artifacts contain duplicates")

    authorities = _mapping(manifest["authorities"], "authorities")
    _exact(
        authorities,
        {
            "architecture",
            "activityBoundary",
            "electronNavigation",
            "electronStorage",
            "electronProtocol",
            "dartProtocol",
        },
        "authorities",
    )
    authority_text: dict[str, str] = {}
    for key, relative in authorities.items():
        _require(isinstance(relative, str), f"authority path is invalid: {key}")
        path = root / relative
        _require(path.is_file(), f"authority is missing: {relative}")
        authority_text[key] = path.read_text(encoding="utf-8")
    for label in ("音频", "互联", "设置"):
        _require(label in authority_text["electronNavigation"], f"navigation authority is missing {label}")
    _require("audio.sqlite3" in authority_text["electronStorage"], "storage authority is not Audio")
    for token in ("companion-audio-transfer/v2", "audio-transfer/v2"):
        _require(token in authority_text["electronProtocol"], f"Electron protocol is missing {token}")
        _require(token in authority_text["dartProtocol"], f"Dart protocol is missing {token}")


def main() -> int:
    try:
        validate()
    except (AudioSidebarValidationError, OSError, ValueError) as error:
        print(f"Audio sidebar workstation validation failed: {error}", file=sys.stderr)
        return 1
    print("Audio sidebar workstation validation passed (U6 release validation pending).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
