#!/usr/bin/env python3
"""Run one U12 gate under the closure deadline and write privacy-safe receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath

from validate_electron_desktop_scope import _sha256


ROOT = Path(__file__).resolve().parents[1]
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9.-]{0,127}$")


def _fail(message: str) -> None:
    raise ValueError(message)


def _safe_path(root: Path, value: str, label: str, *, must_exist: bool) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts:
        _fail(f"{label} is unsafe")
    path = root.joinpath(*relative.parts)
    cursor = root
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            _fail(f"{label} contains a symlink")
    if must_exist and not path.is_file():
        _fail(f"{label} is missing")
    return path


def _timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait(timeout=5)


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--deadline-epoch-ms", type=int, required=True)
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--source-revision")
    parser.add_argument("--relevant-source-sha256")
    parser.add_argument("--target-sha256")
    parser.add_argument("--package-sha256")
    parser.add_argument(
        "--binding",
        action="append",
        default=[],
        metavar="ID:DEFINITION:RECEIPT",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()

    root = ROOT.resolve()
    cwd = arguments.cwd.resolve()
    if root != cwd and root not in cwd.parents:
        _fail("cwd escapes repository")
    if not _IDENTIFIER.fullmatch(arguments.command_id):
        _fail("command ID is invalid")
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        _fail("command is missing")

    parsed_bindings: list[tuple[str, str, Path, str]] = []
    definition_hashes: dict[Path, str] = {}
    for raw in arguments.binding:
        parts = raw.split(":", 2)
        if len(parts) != 3 or not _IDENTIFIER.fullmatch(parts[0]):
            _fail("binding is invalid")
        definition = _safe_path(root, parts[1], "gate definition", must_exist=True)
        receipt = _safe_path(root, parts[2], "gate receipt", must_exist=False)
        definition_sha = definition_hashes.get(definition)
        if definition_sha is None:
            definition_sha = _sha256(definition)
            definition_hashes[definition] = definition_sha
        parsed_bindings.append((parts[0], parts[1], receipt, definition_sha))
    if parsed_bindings:
        for value, pattern, label in (
            (arguments.source_revision, _REVISION, "source revision"),
            (arguments.relevant_source_sha256, _SHA256, "relevant source hash"),
            (arguments.target_sha256, _SHA256, "target hash"),
            (arguments.package_sha256, _SHA256, "package hash"),
        ):
            if not isinstance(value, str) or pattern.fullmatch(value) is None:
                _fail(f"{label} is invalid")

    remaining = (arguments.deadline_epoch_ms - int(time.time() * 1000)) / 1000
    if remaining <= 0:
        _fail("closure deadline has expired")
    started_at = _timestamp()
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, start_new_session=True)
    try:
        exit_code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        _terminate_group(process)
        print(f"{arguments.command_id}: closure deadline exceeded", file=sys.stderr)
        return 124
    elapsed = max(1, int((time.monotonic() - started) * 1000))
    if exit_code != 0:
        return exit_code
    finished_at = _timestamp()
    for identifier, definition_path, receipt_path, definition_sha in parsed_bindings:
        _atomic_json(
            receipt_path,
            {
                "schema": "voice2text-desktop-electron-gate-receipt/v1",
                "id": identifier,
                "mode": "automated",
                "status": "PASS",
                "sourceRevision": arguments.source_revision,
                "relevantSourceSha256": arguments.relevant_source_sha256,
                "targetFingerprintSha256": arguments.target_sha256,
                "packageManifestSha256": arguments.package_sha256,
                "definitionPath": definition_path,
                "definitionSha256": definition_sha,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "elapsedMilliseconds": elapsed,
                "exitCode": 0,
                "commandId": arguments.command_id,
                "procedureId": None,
                "checks": [],
            },
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
