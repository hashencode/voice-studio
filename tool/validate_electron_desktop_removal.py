#!/usr/bin/env python3
"""Fail-closed U14 gate for retiring the Flutter Desktop composition root."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs/product/desktop-electron-removal.json"

_SHA256 = set("0123456789abcdef")
_TOP_LEVEL_FIELDS = {
    "$schema",
    "schema",
    "unit",
    "status",
    "supportScope",
    "historicalClosure",
    "archivedFlutterEvidence",
    "comparisonBaseRevision",
    "relocatedAuthorities",
    "protectedPaths",
    "activeConsumers",
    "flutterDesktop",
    "dataLifecycleImpact",
    "verification",
    "blockers",
}
_HISTORICAL_PATHS = {
    "docs/product/desktop-electron-u12-scope.json",
    "docs/product/desktop-electron-evidence.json",
    "docs/product/desktop-electron-parity-baseline.json",
}
_REQUIRED_PROTECTED_PATHS = {
    "apps/desktop-electron",
    "packages/companion_protocol",
    "packages/desktop_macos_native",
    "packages/desktop_sherpa_worker",
    "packages/meeting_core",
    "packages/meeting_storage",
    "packages/meeting_workflows",
    "packages/processing_contracts",
    "benchmark/desktop",
    "apps/desktop-electron/tests/fixtures/flutter-reference",
    "docs/product/electron-closure-receipts",
}
_FULL_REVISION = set("0123456789abcdef")
_DATA_LIFECYCLE_FIELDS = {
    "electronProfile",
    "keychain",
    "media",
    "journals",
    "checkpoints",
    "receipts",
}
_VERIFICATION_FIELDS = {
    "macosClosure",
    "rootDevCheck",
    "electronCheck",
    "electronPackage",
    "packageSmoke",
    "removalDiffCheck",
}
_FORBIDDEN_ACTIVE_REFERENCE = re.compile(
    r"apps/desktop(?![-\w])|flutter build macos|flutter test apps/desktop"
)
_ARCHIVED_REFERENCE_PREFIX = (
    "apps/desktop-electron/tests/fixtures/flutter-reference/source/apps/desktop/"
)
_ACTIVE_REFERENCE_EXCLUSIONS = {
    "README.md",
    "benchmark/desktop/WINDOWS_ENGINE_VALIDATION.md",
    "docs/product/desktop-electron-evidence.json",
    "docs/product/desktop-electron-parity-baseline.json",
    "docs/product/desktop-electron-removal.json",
    "docs/product/desktop-workstation-status.md",
    "tool/check_desktop_foundation.sh",
    "tool/test_validate_electron_desktop_removal.py",
    "tool/test_validate_electron_desktop_scope.py",
    "tool/validate_electron_desktop_removal.py",
    "tool/validate_electron_desktop_scope.py",
}
_ACTIVE_REFERENCE_EXCLUSION_PREFIXES = (
    "apps/desktop-electron/tests/fixtures/flutter-reference/",
    "benchmark/desktop/capture/evidence/",
    "docs/plans/",
    "docs/product/desktop-workstation-u",
)
_REQUIRED_ACTIVE_CONSUMERS = {
    "tool/dev_check.sh",
    "tool/build_cache_guard.py",
    "tool/check_desktop_benchmark.sh",
    "tool/check_privacy_contract.sh",
    "apps/desktop-electron/scripts/build-worker-resources.sh",
    "apps/desktop-electron/scripts/build-live-caption-resources.sh",
    "apps/desktop-electron/scripts/materialize-frozen-sherpa-resources.ts",
    "apps/desktop-electron/scripts/smoke-packaged-processing-macos.ts",
    "apps/desktop-electron/tests/unit/build_worker_resources_test.ts",
    "benchmark/desktop/run_macos_sherpa_baseline.sh",
    "benchmark/desktop/run_offline_vertical_slice.sh",
    "benchmark/desktop/live_caption/run_live_caption_benchmark.dart",
    "benchmark/desktop/asr_comparison/build_m4_qwen3_official_rtf_reproduction_report.py",
    "benchmark/desktop/asr_comparison/run_qwen3_official_rtf_reproduction.py",
    "benchmark/desktop/asr_comparison/development_matrix.py",
}
_RELEVANT_ELECTRON_PATHS = (
    "apps/desktop-electron/src",
    "apps/desktop-electron/scripts",
    "apps/desktop-electron/tests",
    "apps/desktop-electron/package.json",
    "apps/desktop-electron/bun.lock",
    "apps/desktop-electron/forge.config.ts",
    "apps/desktop-electron/vite.main.config.mts",
    "apps/desktop-electron/vite.preload.config.mts",
    "apps/desktop-electron/vite.renderer.config.mts",
)
_REQUIRED_RELOCATED_AUTHORITIES = {
    (
        "apps/desktop/tool/processing_sidecar/README.md",
        "benchmark/desktop/processing_sidecar/README.md",
    ),
    (
        "apps/desktop/tool/processing_sidecar/launcher.py",
        "benchmark/desktop/processing_sidecar/launcher.py",
    ),
    (
        "apps/desktop/tool/processing_sidecar/worker.py",
        "benchmark/desktop/processing_sidecar/worker.py",
    ),
    (
        "apps/desktop/tool/u8_lan_receiver_smoke.dart",
        "packages/companion_protocol/tool/u8_lan_receiver_smoke.dart",
    ),
    (
        "apps/desktop/assets/processing/frozen_sensevoice_macos_arm64.json",
        "packages/desktop_sherpa_worker/assets/processing/frozen_sensevoice_macos_arm64.json",
    ),
    (
        "apps/desktop/assets/processing/frozen_sherpa_macos_arm64.json",
        "packages/desktop_sherpa_worker/assets/processing/frozen_sherpa_macos_arm64.json",
    ),
    (
        "apps/desktop/tool/desktop_sensevoice_caption_worker.dart",
        "packages/desktop_sherpa_worker/bin/desktop_sensevoice_caption_worker.dart",
    ),
    (
        "apps/desktop/lib/features/processing/sidecar/sidecar_sandbox.dart",
        "packages/desktop_sherpa_worker/lib/src/sidecar_sandbox.dart",
    ),
    (
        "apps/desktop/tool/native_process_group_launcher.c",
        "packages/desktop_sherpa_worker/native/macos/native_process_group_launcher.c",
    ),
    (
        "apps/desktop/tool/asr_benchmark/candidate_registry.dart",
        "packages/desktop_sherpa_worker/tool/asr_benchmark/candidate_registry.dart",
    ),
    (
        "apps/desktop/tool/asr_benchmark/effective_profile.dart",
        "packages/desktop_sherpa_worker/tool/asr_benchmark/effective_profile.dart",
    ),
    (
        "apps/desktop/tool/desktop_asr_candidate_worker.dart",
        "packages/desktop_sherpa_worker/tool/desktop_asr_candidate_worker.dart",
    ),
    (
        "apps/desktop/tool/desktop_sherpa_benchmark.dart",
        "packages/desktop_sherpa_worker/tool/desktop_sherpa_benchmark.dart",
    ),
    (
        "apps/desktop/tool/offline_vertical_slice.dart",
        "packages/desktop_sherpa_worker/tool/offline_vertical_slice.dart",
    ),
    (
        "apps/desktop/tool/qwen3_official_rtf_diagnostic_worker.dart",
        "packages/desktop_sherpa_worker/tool/qwen3_official_rtf_diagnostic_worker.dart",
    ),
}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _exact_fields(value: dict[str, Any], expected: set[str], label: str) -> None:
    _require(set(value) == expected, f"{label} field set is invalid")


def _sha(value: Any, label: str) -> str:
    _require(
        isinstance(value, str)
        and len(value) == 64
        and set(value) <= _SHA256,
        f"{label} is not a lowercase SHA-256",
    )
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _git_blob_sha256(root: Path, revision: str, relative: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{revision}:{relative}"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def _safe_path(root: Path, value: Any, label: str) -> Path:
    _require(isinstance(value, str) and value, f"{label} path is invalid")
    relative = PurePosixPath(value)
    _require(
        not relative.is_absolute() and ".." not in relative.parts,
        f"{label} path escapes the repository",
    )
    path = root.joinpath(*relative.parts)
    _require(path.exists(), f"{label} path is missing: {value}")
    current = path
    while current != root:
        _require(not current.is_symlink(), f"{label} path contains a symlink")
        current = current.parent
    return path


def _path_tree_sha256(path: Path) -> str:
    """Hash a file or directory by relative name, mode and file content."""
    _require(path.exists(), f"protected path is missing: {path}")
    _require(not path.is_symlink(), f"protected path is a symlink: {path}")
    entries = [path] if path.is_file() else sorted(path.rglob("*"))
    digest = hashlib.sha256()
    for entry in entries:
        _require(not entry.is_symlink(), f"protected path contains a symlink")
        if not entry.is_file():
            continue
        relative = entry.name if path.is_file() else entry.relative_to(path).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(f"{entry.stat().st_mode & 0o777:o}".encode())
        digest.update(b"\0")
        digest.update(_sha256(entry).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _tracked_path_tree_sha256(root: Path, relative: str) -> str:
    result = subprocess.run(
        ["git", "ls-files", "-s", "--", relative],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    rows = [row for row in result.stdout.splitlines() if row]
    _require(rows, f"protected path has no tracked files: {relative}")
    digest = hashlib.sha256()
    for row in rows:
        metadata, tracked_path = row.split("\t", 1)
        mode = metadata.split(" ", 1)[0]
        path = _safe_path(root, tracked_path, "protected path")
        _require(path.is_file(), f"protected path is not a regular file: {tracked_path}")
        digest.update(tracked_path.removeprefix(f"{relative.rstrip('/')}/").encode())
        digest.update(b"\0")
        digest.update(mode.encode())
        digest.update(b"\0")
        digest.update(_sha256(path).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _validate_no_retired_consumers(
    root: Path,
    tracked_paths: list[str] | None = None,
) -> None:
    if tracked_paths is None:
        result = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        tracked_paths = [
            value.decode()
            for value in result.stdout.split(b"\0")
            if value
        ]
    for relative in tracked_paths:
        if relative in _ACTIVE_REFERENCE_EXCLUSIONS or relative.startswith(
            _ACTIVE_REFERENCE_EXCLUSION_PREFIXES
        ):
            continue
        path = root / relative
        if not path.is_file() or path.is_symlink():
            continue
        content = path.read_bytes()
        if b"\0" in content:
            continue
        text = content.decode("utf-8", errors="replace").replace(
            _ARCHIVED_REFERENCE_PREFIX,
            "ARCHIVED_FLUTTER_REFERENCE/",
        )
        _require(
            _FORBIDDEN_ACTIVE_REFERENCE.search(text) is None,
            f"tracked active file still references Flutter Desktop: {relative}",
        )


def validate_electron_desktop_removal(
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    root: Path = ROOT,
    validate_repository: bool = True,
) -> dict[str, object]:
    root = root.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = _mapping(manifest, "removal manifest")
    _exact_fields(manifest, _TOP_LEVEL_FIELDS, "removal manifest")
    _require(
        manifest.get("schema") == "voice2text-desktop-electron-removal/v1",
        "removal manifest schema mismatch",
    )
    _require(manifest.get("unit") == "U14", "removal unit mismatch")
    _require(manifest.get("status") == "PASS", "Flutter Desktop removal is not complete")
    _require(manifest.get("blockers") == [], "removal blockers must be empty")

    support = _mapping(manifest.get("supportScope"), "support scope")
    _exact_fields(
        support,
        {"decisionId", "authority", "supportedTargets", "windows"},
        "support scope",
    )
    _require(
        support.get("decisionId") == "MACOS_ONLY_SUPPORTED_SCOPE_2026_08_17"
        and support.get("authority") == "user-directed"
        and support.get("supportedTargets") == ["macos"],
        "supported target scope is invalid",
    )
    windows = _mapping(support.get("windows"), "Windows disposition")
    _require(
        windows
        == {
            "status": "DEFERRED_OUT_OF_CURRENT_SCOPE",
            "inheritsMacosPass": False,
            "evidence": None,
        },
        "Windows must remain deferred without PASS or inherited evidence",
    )

    historical = _array(manifest.get("historicalClosure"), "historical closure")
    historical_paths = {item.get("path") for item in historical if isinstance(item, dict)}
    _require(historical_paths == _HISTORICAL_PATHS, "historical closure set is invalid")
    for raw in historical:
        item = _mapping(raw, "historical closure binding")
        _exact_fields(item, {"path", "sha256"}, "historical closure binding")
        path = _safe_path(root, item.get("path"), "historical closure")
        _require(path.is_file(), "historical closure binding must be a file")
        _require(_sha256(path) == _sha(item.get("sha256"), "historical closure hash"), "historical closure hash drift")

    archives = _array(manifest.get("archivedFlutterEvidence"), "archived Flutter evidence")
    _require(archives, "archived Flutter evidence is empty")
    original_paths: set[str] = set()
    archive_paths: set[str] = set()
    for raw in archives:
        item = _mapping(raw, "archived Flutter evidence binding")
        _exact_fields(item, {"originalPath", "archivePath", "sha256"}, "archived Flutter evidence binding")
        original = item.get("originalPath")
        archive = item.get("archivePath")
        _require(isinstance(original, str) and original.startswith("apps/desktop/"), "archive original path is invalid")
        _require(isinstance(archive, str) and archive.startswith("apps/desktop-electron/tests/fixtures/flutter-reference/source/"), "archive destination is invalid")
        _require(original not in original_paths and archive not in archive_paths, "archive mapping is duplicated")
        original_paths.add(original)
        archive_paths.add(archive)
        path = _safe_path(root, archive, "archived Flutter evidence")
        _require(path.is_file(), "archived Flutter evidence must be a file")
        destination_hash = _sha256(path)
        _require(destination_hash == _sha(item.get("sha256"), "archive hash"), "archived Flutter evidence hash drift")

    comparison_base = manifest.get("comparisonBaseRevision")
    _require(
        isinstance(comparison_base, str)
        and len(comparison_base) == 40
        and set(comparison_base) <= _FULL_REVISION,
        "comparison base revision is invalid",
    )
    if validate_repository:
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", comparison_base, "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        for raw in archives:
            original = str(raw["originalPath"])
            archive = root / str(raw["archivePath"])
            _require(
                _git_blob_sha256(root, comparison_base, original) == _sha256(archive),
                f"archived Flutter evidence differs from comparison base: {original}",
            )

    relocations = _array(manifest.get("relocatedAuthorities"), "relocated authorities")
    _require(relocations, "relocated authority set is empty")
    relocated_sources: set[str] = set()
    relocated_destinations: set[str] = set()
    relocation_pairs: set[tuple[str, str]] = set()
    for raw in relocations:
        item = _mapping(raw, "relocated authority binding")
        _exact_fields(item, {"originalPath", "destinationPath", "sha256"}, "relocated authority binding")
        original = item.get("originalPath")
        destination = item.get("destinationPath")
        _require(isinstance(original, str) and original.startswith("apps/desktop/"), "relocated authority source is invalid")
        _require(isinstance(destination, str) and not destination.startswith("apps/desktop/"), "relocated authority destination is invalid")
        _require(original not in relocated_sources and destination not in relocated_destinations, "relocated authority mapping is duplicated")
        relocated_sources.add(original)
        relocated_destinations.add(destination)
        relocation_pairs.add((original, destination))
        path = _safe_path(root, destination, "relocated authority")
        _require(path.is_file(), "relocated authority must be a file")
        destination_hash = _sha256(path)
        _require(destination_hash == _sha(item.get("sha256"), "relocated authority hash"), "relocated authority hash drift")
        if validate_repository:
            _require(
                _git_blob_sha256(root, comparison_base, original) == destination_hash,
                f"relocated authority differs from comparison base: {original}",
            )
    _require(
        relocation_pairs == _REQUIRED_RELOCATED_AUTHORITIES,
        "relocated authority set is incomplete",
    )

    protected = _array(manifest.get("protectedPaths"), "protected paths")
    protected_paths = {item.get("path") for item in protected if isinstance(item, dict)}
    if validate_repository:
        _require(_REQUIRED_PROTECTED_PATHS <= protected_paths, "protected path set is incomplete")
        untracked_electron = subprocess.run(
            [
                "git",
                "ls-files",
                "--others",
                "--exclude-standard",
                "--",
                *_RELEVANT_ELECTRON_PATHS,
            ],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        _require(
            not untracked_electron,
            "untracked Electron source can invalidate the current source binding",
        )
    for raw in protected:
        item = _mapping(raw, "protected path binding")
        _exact_fields(item, {"path", "treeSha256"}, "protected path binding")
        relative = item.get("path")
        path = _safe_path(root, relative, "protected path")
        actual = (
            _tracked_path_tree_sha256(root, str(relative))
            if validate_repository
            else _path_tree_sha256(path)
        )
        _require(actual == _sha(item.get("treeSha256"), "protected tree hash"), "protected path hash drift")

    consumers = _array(manifest.get("activeConsumers"), "active consumers")
    _require(
        set(consumers) == _REQUIRED_ACTIVE_CONSUMERS
        and len(consumers) == len(_REQUIRED_ACTIVE_CONSUMERS),
        "active consumer set is invalid",
    )
    for relative in consumers:
        path = _safe_path(root, relative, "active consumer")
        _require(path.is_file(), "active consumer must be a file")
        text = path.read_text(encoding="utf-8").replace(
            _ARCHIVED_REFERENCE_PREFIX,
            "ARCHIVED_FLUTTER_REFERENCE/",
        )
        _require(
            _FORBIDDEN_ACTIVE_REFERENCE.search(text) is None,
            f"active consumer still references Flutter Desktop: {relative}",
        )
    if validate_repository:
        _validate_no_retired_consumers(root)

    flutter = _mapping(manifest.get("flutterDesktop"), "Flutter Desktop state")
    _require(
        flutter
        == {
            "sourceRoot": "apps/desktop",
            "trackedFilesExpected": 0,
            "worktreeState": "ABSENT",
        },
        "Flutter Desktop state is invalid",
    )
    desktop_root = root / "apps/desktop"
    _require(
        not desktop_root.exists() and not desktop_root.is_symlink(),
        "Flutter Desktop source root still exists",
    )
    if validate_repository:
        tracked = subprocess.run(
            ["git", "ls-files", "--", "apps/desktop"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        _require(not tracked, "Flutter Desktop tracked files remain")

    lifecycle = _mapping(manifest.get("dataLifecycleImpact"), "data lifecycle impact")
    _exact_fields(lifecycle, _DATA_LIFECYCLE_FIELDS, "data lifecycle impact")
    _require(set(lifecycle.values()) == {"UNTOUCHED"}, "data lifecycle removal action is prohibited")

    verification = _mapping(manifest.get("verification"), "verification")
    _exact_fields(verification, _VERIFICATION_FIELDS, "verification")
    _require(set(verification.values()) == {"PASS"}, "removal verification is incomplete")

    return {
        "status": "PASS",
        "unit": "U14",
        "supportedTargets": ["macos"],
        "windows": "DEFERRED_OUT_OF_CURRENT_SCOPE",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--root", type=Path, default=ROOT)
    arguments = parser.parse_args()
    print(
        json.dumps(
            validate_electron_desktop_removal(
                arguments.manifest,
                root=arguments.root,
            ),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
