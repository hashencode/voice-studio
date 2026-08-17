#!/usr/bin/env python3
"""Package-once prepare/finalize gate for the Audio/sidebar-09 macOS candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable, Sequence


ROOT = pathlib.Path(__file__).resolve().parent.parent
ELECTRON_ROOT = ROOT / "apps/desktop-electron"
PACKAGE_PATH = ELECTRON_ROOT / "out/Voice2Text-darwin-arm64/Voice2Text.app"
RELEASE_ROOT = ROOT / "docs/product/audio-sidebar-release"
CANDIDATE_RECEIPT = RELEASE_ROOT / "candidate.json"
MANUAL_RECEIPT = RELEASE_ROOT / "manual.json"
FINAL_RECEIPT = RELEASE_ROOT / "final.json"
MANUAL_DEFINITION = ROOT / "docs/product/audio-sidebar-manual-checks.json"
PRODUCT_MANIFEST = ROOT / "docs/product/audio-sidebar-workstation.json"
INPUT_PATHS = (
    "apps/desktop-electron",
    "packages/audio_core",
    "packages/audio_storage",
    "packages/audio_workflows",
    "packages/companion_protocol",
    "packages/desktop_macos_native",
    "packages/desktop_sherpa_worker",
    "packages/processing_contracts",
)
PREPARE_COMMANDS = (
    (
        "build-cache-guard",
        ("python3", "tool/build_cache_guard.py", "--wait-for-idle"),
        ROOT,
    ),
    ("electron-check", ("bun", "run", "check"), ELECTRON_ROOT),
    ("package-once", ("bun", "run", "package"), ELECTRON_ROOT),
    ("package-bootstrap", ("bun", "run", "smoke:package"), ELECTRON_ROOT),
    (
        "packaged-product-matrix",
        ("bunx", "vitest", "run", "tests/packaged"),
        ELECTRON_ROOT,
    ),
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
REVISION = re.compile(r"^[a-f0-9]{40}$")


class CandidateError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CandidateError(message)


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_tree_sha256(path: pathlib.Path) -> str:
    _require(path.is_dir(), f"candidate package is missing: {path}")
    digest = hashlib.sha256()
    for item in sorted(path.rglob("*"), key=lambda value: value.relative_to(path).as_posix()):
        relative = item.relative_to(path).as_posix()
        metadata = item.lstat()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(metadata.st_mode):o}".encode("ascii"))
        digest.update(b"\0")
        if item.is_symlink():
            digest.update(b"L\0")
            digest.update(os.readlink(item).encode("utf-8"))
        elif item.is_file():
            digest.update(b"F\0")
            digest.update(_sha256_file(item).encode("ascii"))
        elif item.is_dir():
            digest.update(b"D\0")
        else:
            raise CandidateError(f"unsupported package entry: {relative}")
        digest.update(b"\n")
    return digest.hexdigest()


def _git(*arguments: str, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *arguments),
        cwd=ROOT,
        check=True,
        capture_output=capture,
        text=True,
    )


def committed_candidate_identity() -> tuple[str, str]:
    revision = _git("rev-parse", "HEAD").stdout.strip()
    _require(bool(REVISION.fullmatch(revision)), "candidate revision is invalid")
    dirty = subprocess.run(
        ("git", "diff", "--quiet", "HEAD", "--", *INPUT_PATHS),
        cwd=ROOT,
        check=False,
    )
    _require(dirty.returncode == 0, "candidate product/package inputs are dirty")
    untracked = _git(
        "ls-files", "--others", "--exclude-standard", "--", *INPUT_PATHS
    ).stdout.strip()
    _require(not untracked, "candidate product/package inputs contain untracked files")
    tree = _git("ls-tree", "-r", "--full-tree", "HEAD", "--", *INPUT_PATHS).stdout
    _require(bool(tree.strip()), "candidate input tree is empty")
    return revision, hashlib.sha256(tree.encode("utf-8")).hexdigest()


def _is_ancestor(ancestor: str, revision: str) -> bool:
    return (
        subprocess.run(
            ("git", "merge-base", "--is-ancestor", ancestor, revision),
            cwd=ROOT,
            check=False,
        ).returncode
        == 0
    )


def _sysctl(name: str) -> str:
    result = subprocess.run(
        ("/usr/sbin/sysctl", "-n", name),
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def target_fingerprint() -> dict[str, Any]:
    _require(sys.platform == "darwin", "U6 candidate must be prepared on macOS")
    target = {
        "operatingSystem": "macos",
        "operatingSystemVersion": platform.mac_ver()[0],
        "architecture": platform.machine(),
        "cpuModel": _sysctl("machdep.cpu.brand_string"),
        "logicalCpuCount": int(_sysctl("hw.logicalcpu")),
        "memoryBytes": int(_sysctl("hw.memsize")),
    }
    return {**target, "sha256": hashlib.sha256(_canonical(target)).hexdigest()}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def _run_command(command: Sequence[str], cwd: pathlib.Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def prepare(
    *,
    runner: Callable[[Sequence[str], pathlib.Path], None] = _run_command,
) -> dict[str, Any]:
    _require(not CANDIDATE_RECEIPT.exists(), "candidate was already prepared")
    _require(not FINAL_RECEIPT.exists(), "candidate was already finalized")
    source_revision, input_sha = committed_candidate_identity()
    started = _timestamp()
    commands: list[dict[str, Any]] = []
    for identifier, command, cwd in PREPARE_COMMANDS:
        command_started = time.monotonic()
        runner(command, cwd)
        commands.append(
            {
                "id": identifier,
                "command": list(command),
                "status": "PASS",
                "elapsedMs": round((time.monotonic() - command_started) * 1000),
            }
        )
    executable = PACKAGE_PATH / "Contents/MacOS/Voice2Text"
    worker_manifest = PACKAGE_PATH / "Contents/Resources/worker/manifest.json"
    _require(executable.is_file(), "packaged executable is missing")
    _require(worker_manifest.is_file(), "packaged worker manifest is missing")
    package_sha = package_tree_sha256(PACKAGE_PATH)
    receipt = {
        "schema": "voice2text-audio-sidebar-candidate/v1",
        "status": "AUTOMATED_PASS_MANUAL_PENDING",
        "sourceRevision": source_revision,
        "candidateInputsSha256": input_sha,
        "preparedAt": started,
        "automatedFinishedAt": _timestamp(),
        "target": target_fingerprint(),
        "package": {
            "path": PACKAGE_PATH.relative_to(ROOT).as_posix(),
            "manifestAlgorithm": "sorted-path-mode-content-sha256/v1",
            "manifestSha256": package_sha,
            "executableSha256": _sha256_file(executable),
            "workerManifestSha256": _sha256_file(worker_manifest),
        },
        "automated": commands,
    }
    definition = json.loads(MANUAL_DEFINITION.read_text(encoding="utf-8"))
    manual = {
        "schema": "voice2text-audio-sidebar-manual-receipt/v1",
        "status": "PENDING",
        "sourceRevision": source_revision,
        "packageManifestSha256": package_sha,
        "targetSha256": receipt["target"]["sha256"],
        "startedAt": None,
        "finishedAt": None,
        "elapsedMs": None,
        "operator": None,
        "checks": [
            {"id": item["id"], "status": "PENDING"}
            for item in definition["checks"]
        ],
    }
    _write_json(CANDIDATE_RECEIPT, receipt)
    _write_json(MANUAL_RECEIPT, manual)
    return receipt


def _load(path: pathlib.Path, label: str) -> dict[str, Any]:
    _require(path.is_file(), f"{label} is missing")
    value = json.loads(path.read_text(encoding="utf-8"))
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def validate_manual(candidate: dict[str, Any], manual: dict[str, Any]) -> None:
    definition = _load(MANUAL_DEFINITION, "manual definition")
    required_ids = [item["id"] for item in definition["checks"]]
    package = candidate.get("package")
    target = candidate.get("target")
    _require(isinstance(package, dict) and isinstance(target, dict), "candidate identity is incomplete")
    _require(manual.get("schema") == "voice2text-audio-sidebar-manual-receipt/v1", "manual schema drifted")
    _require(manual.get("status") == "PASS", "manual result is not PASS")
    _require(manual.get("sourceRevision") == candidate.get("sourceRevision"), "manual source revision drifted")
    _require(manual.get("packageManifestSha256") == package.get("manifestSha256"), "manual package identity drifted")
    _require(manual.get("targetSha256") == target.get("sha256"), "manual target identity drifted")
    _require(isinstance(manual.get("operator"), str) and manual["operator"], "manual operator is missing")
    _require(isinstance(manual.get("startedAt"), str), "manual start time is missing")
    _require(isinstance(manual.get("finishedAt"), str), "manual finish time is missing")
    elapsed = manual.get("elapsedMs")
    _require(
        isinstance(elapsed, int)
        and 0 < elapsed <= int(definition["maximumSessionMinutes"]) * 60_000,
        "manual elapsed time is invalid",
    )
    checks = manual.get("checks")
    _require(isinstance(checks, list), "manual checks are missing")
    _require(
        checks == [{"id": identifier, "status": "PASS"} for identifier in required_ids],
        "manual checks are incomplete or reordered",
    )


def verify_candidate_identity(candidate: dict[str, Any]) -> None:
    revision, input_sha = committed_candidate_identity()
    source_revision = candidate.get("sourceRevision")
    _require(
        isinstance(source_revision, str)
        and bool(REVISION.fullmatch(source_revision)),
        "candidate source revision is invalid",
    )
    _require(
        revision == source_revision or _is_ancestor(source_revision, revision),
        "candidate source revision is not an ancestor of the current revision",
    )
    _require(input_sha == candidate.get("candidateInputsSha256"), "candidate input tree changed")
    package = candidate.get("package")
    _require(isinstance(package, dict), "candidate package identity is missing")
    expected = package.get("manifestSha256")
    _require(bool(SHA256.fullmatch(str(expected))), "candidate package hash is invalid")
    _require(package_tree_sha256(PACKAGE_PATH) == expected, "candidate package changed")


def finalize() -> dict[str, Any]:
    _require(not FINAL_RECEIPT.exists(), "candidate was already finalized")
    candidate = _load(CANDIDATE_RECEIPT, "candidate receipt")
    _require(candidate.get("status") == "AUTOMATED_PASS_MANUAL_PENDING", "automated candidate is not ready")
    manual = _load(MANUAL_RECEIPT, "manual receipt")
    verify_candidate_identity(candidate)
    validate_manual(candidate, manual)
    package = candidate["package"]
    final = {
        "schema": "voice2text-audio-sidebar-final/v1",
        "status": "PASS",
        "sourceRevision": candidate["sourceRevision"],
        "candidateInputsSha256": candidate["candidateInputsSha256"],
        "packageManifestSha256": package["manifestSha256"],
        "targetSha256": candidate["target"]["sha256"],
        "candidateReceiptSha256": _sha256_file(CANDIDATE_RECEIPT),
        "manualReceiptSha256": _sha256_file(MANUAL_RECEIPT),
        "finalizedAt": _timestamp(),
        "rebuildPerformed": False,
    }
    _write_json(FINAL_RECEIPT, final)
    product = _load(PRODUCT_MANIFEST, "Audio/sidebar product manifest")
    product["status"] = "RELEASE_VALIDATED"
    product["releaseCandidate"] = {
        "status": "PASS",
        "sourceRevision": candidate["sourceRevision"],
        "packageManifestSha256": package["manifestSha256"],
        "automatedReceipt": CANDIDATE_RECEIPT.relative_to(ROOT).as_posix(),
        "manualReceipt": MANUAL_RECEIPT.relative_to(ROOT).as_posix(),
        "finalizeRebuilds": False,
    }
    _write_json(PRODUCT_MANIFEST, product)
    return final


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "finalize", "verify"))
    arguments = parser.parse_args()
    try:
        if arguments.action == "prepare":
            result = prepare()
        elif arguments.action == "finalize":
            result = finalize()
        else:
            candidate = _load(CANDIDATE_RECEIPT, "candidate receipt")
            verify_candidate_identity(candidate)
            result = {"status": "PASS", "identity": "UNCHANGED"}
    except (CandidateError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Audio/sidebar candidate {arguments.action} failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
