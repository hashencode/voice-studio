#!/usr/bin/env python3
"""Package-once prepare/finalize gate for the Audio/sidebar-09 macOS candidate."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable, Sequence


ROOT = pathlib.Path(__file__).resolve().parent.parent
ELECTRON_ROOT = ROOT / "apps/desktop-electron"
PACKAGE_PATH = ELECTRON_ROOT / "out/Voice2Text-darwin-arm64/Voice2Text.app"
RELEASE_ROOT = ROOT / "docs/product/audio-sidebar-release"
CANDIDATE_RECEIPT = RELEASE_ROOT / "candidate.json"
MANUAL_RECEIPT = RELEASE_ROOT / "manual.json"
FINAL_RECEIPT = RELEASE_ROOT / "final.json"
PREPARE_STATE = RELEASE_ROOT / ".prepare-state.json"
MANUAL_DEFINITION = ROOT / "docs/product/audio-sidebar-manual-checks.json"
PRODUCT_MANIFEST = ROOT / "docs/product/audio-sidebar-workstation.json"
INPUT_PATHS = (
    "pubspec.lock",
    "apps/mobile-flutter",
    "apps/desktop-electron",
    "packages/audio_core",
    "packages/audio_storage",
    "packages/audio_workflows",
    "packages/companion_protocol",
    "packages/desktop_macos_native",
    "packages/desktop_sherpa_worker",
    "packages/processing_contracts",
    "docs/contracts/companion-audio-transfer-v2.schema.json",
    "docs/architecture/audio-activity-source-boundary.json",
    "docs/product/audio-sidebar-manual-checks.json",
    "tool/audio_sidebar_release_candidate.py",
    "tool/validate_companion_audio_transfer_contract.py",
    "tool/test_validate_companion_audio_transfer_contract.py",
    "tool/validate_audio_sidebar_workstation.py",
)
PREPARE_COMMANDS = (
    (
        "build-cache-guard",
        ("python3", "tool/build_cache_guard.py", "--wait-for-idle"),
        ROOT,
    ),
    ("electron-check", ("bun", "run", "check"), ELECTRON_ROOT),
    ("renderer-visual", ("bun", "run", "test:visual"), ELECTRON_ROOT),
    ("package-once", ("bun", "run", "package"), ELECTRON_ROOT),
    ("package-bootstrap", ("bun", "run", "smoke:package"), ELECTRON_ROOT),
    (
        "packaged-bootstrap-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_SMOKE=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_bootstrap_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-processing-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_PROCESSING=1",
            "RUN_DIRECT_PACKAGED_PROCESSING=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_processing_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-workstation-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_WORKSTATION=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_local_workstation_dogfood_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-companion-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_COMPANION_SMOKE=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_companion_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-capture-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_CAPTURE_INITIALIZE_ONLY=0",
            "RUN_PACKAGED_CAPTURE_SMOKE=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_capture_recovery_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-live-caption-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_LIVE_CAPTION=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_live_caption_worker_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-caption-formal-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_CAPTION_FORMAL=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_caption_formal_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-ai-boundary-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_AI_BOUNDARY=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_ai_boundary_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
    (
        "packaged-native-security-test",
        (
            "/usr/bin/env",
            "RUN_PACKAGED_NATIVE_SECURITY_SMOKE=1",
            "bunx",
            "vitest",
            "run",
            "tests/packaged/macos_native_security_helper_smoke_test.ts",
        ),
        ELECTRON_ROOT,
    ),
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
REVISION = re.compile(r"^[a-f0-9]{40}$")
UTC_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)


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


def _tool_output(command: Sequence[str]) -> str:
    result = subprocess.run(
        command,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return (result.stdout + result.stderr).strip()


def execution_environment_fingerprint() -> dict[str, Any]:
    tools: dict[str, dict[str, str]] = {}
    for name, version_command in (
        ("bun", ("bun", "--version")),
        ("dart", ("dart", "--version")),
        ("flutter", ("flutter", "--version", "--machine")),
        ("xcodebuild", ("xcodebuild", "-version")),
        ("clang", ("clang", "--version")),
        ("swift", ("swift", "--version")),
    ):
        executable = shutil.which(name)
        _require(executable is not None, f"required release tool is missing: {name}")
        tools[name] = {
            "path": str(pathlib.Path(executable).resolve()),
            "version": _tool_output(version_command),
        }
    environment_names = (
        "CODE_SIGNING_ALLOWED",
        "DEVELOPMENT_TEAM",
        "EXPANDED_CODE_SIGN_IDENTITY",
        "RUN_PACKAGED_NATIVE_SECURITY_KEYCHAIN_MUTATION",
        "VOICE2TEXT_DART_EXECUTABLE",
        "VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD",
        "VOICE2TEXT_MACOS_SIGN_IDENTITY",
        "VOICE2TEXT_RESOURCE_CACHE_DIR",
        "VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB",
    )
    fingerprint: dict[str, Any] = {
        "tools": tools,
        "environment": {
            name: os.environ.get(name) for name in environment_names
        },
    }
    return {
        **fingerprint,
        "sha256": hashlib.sha256(_canonical(fingerprint)).hexdigest(),
    }


def _resource_acquisition_mode() -> str:
    return (
        "force-fresh"
        if os.environ.get("VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD") == "1"
        else "cache-allowed"
    )


def _command_matrix_sha256() -> str:
    matrix = [
        {
            "id": identifier,
            "command": list(command),
            "cwd": str(cwd.resolve()),
        }
        for identifier, command, cwd in PREPARE_COMMANDS
    ]
    return hashlib.sha256(_canonical(matrix)).hexdigest()


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_utc_timestamp(value: Any, label: str) -> datetime:
    _require(
        isinstance(value, str) and bool(UTC_TIMESTAMP.fullmatch(value)),
        f"{label} is invalid",
    )
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise CandidateError(f"{label} is invalid") from error


def _write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _release_operation_lock():
    lock_path = PREPARE_STATE.with_name(".candidate-operation.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        os.chmod(lock_path, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _serialized_release_operation(operation):
    @wraps(operation)
    def serialized(*args, **kwargs):
        with _release_operation_lock():
            return operation(*args, **kwargs)

    return serialized


def _run_command(command: Sequence[str], cwd: pathlib.Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def _validate_product_manifest() -> None:
    subprocess.run(
        (sys.executable, str(ROOT / "tool/validate_audio_sidebar_workstation.py")),
        cwd=ROOT,
        check=True,
    )


def _product_contract_sha256() -> str:
    product = _load(PRODUCT_MANIFEST, "Audio/sidebar product manifest")
    contract = {
        key: value
        for key, value in product.items()
        if key not in {"status", "releaseCandidate"}
    }
    return hashlib.sha256(_canonical(contract)).hexdigest()


def _pending_manual_receipt(candidate: dict[str, Any]) -> dict[str, Any]:
    definition = _load(MANUAL_DEFINITION, "manual definition")
    package = candidate.get("package")
    target = candidate.get("target")
    _require(
        isinstance(package, dict) and isinstance(target, dict),
        "candidate identity is incomplete",
    )
    return {
        "schema": "voice2text-audio-sidebar-manual-receipt/v1",
        "status": "PENDING",
        "sourceRevision": candidate["sourceRevision"],
        "packageManifestSha256": package["manifestSha256"],
        "targetSha256": target["sha256"],
        "startedAt": None,
        "finishedAt": None,
        "elapsedMs": None,
        "operator": None,
        "checks": [
            {"id": item["id"], "status": "PENDING"}
            for item in definition["checks"]
        ],
    }


def _validate_candidate_receipt(
    candidate: dict[str, Any], *, package_already_verified: bool = False
) -> None:
    _require(
        candidate.get("schema") == "voice2text-audio-sidebar-candidate/v1",
        "candidate receipt schema drifted",
    )
    _require(
        candidate.get("status") == "AUTOMATED_PASS_MANUAL_PENDING",
        "automated candidate is not ready",
    )
    automated = candidate.get("automated")
    _require(
        isinstance(automated, list)
        and len(automated) == len(PREPARE_COMMANDS),
        "candidate automated results do not match prepare commands",
    )
    for result, (identifier, command, _cwd) in zip(
        automated, PREPARE_COMMANDS, strict=True
    ):
        _require(
            isinstance(result, dict)
            and set(result) == {"id", "command", "status", "elapsedMs"},
            "candidate automated result fields drifted",
        )
        _require(
            result.get("id") == identifier
            and result.get("command") == list(command),
            "candidate automated commands drifted",
        )
        _require(
            result.get("status") == "PASS",
            "candidate automated result is not PASS",
        )
        elapsed = result.get("elapsedMs")
        _require(
            type(elapsed) is int and elapsed >= 0,
            "candidate automated elapsed time is invalid",
        )
    product_contract_sha = candidate.get("productContractSha256")
    _require(
        isinstance(product_contract_sha, str)
        and bool(SHA256.fullmatch(product_contract_sha)),
        "candidate product contract hash is invalid",
    )
    _require(
        product_contract_sha == _product_contract_sha256(),
        "candidate product contract changed",
    )
    target = candidate.get("target")
    _require(
        isinstance(target, dict)
        and bool(SHA256.fullmatch(str(target.get("sha256")))),
        "candidate target identity is invalid",
    )
    verify_candidate_identity(candidate, verify_package=not package_already_verified)


def _recover_prepared_candidate() -> dict[str, Any]:
    candidate = _load(CANDIDATE_RECEIPT, "candidate receipt")
    _validate_candidate_receipt(candidate)
    expected_manual = _pending_manual_receipt(candidate)
    if MANUAL_RECEIPT.exists():
        manual = _load(MANUAL_RECEIPT, "manual receipt")
        if manual.get("status") == "PASS":
            validate_manual(candidate, manual)
        else:
            _require(
                manual == expected_manual,
                "manual receipt conflicts with prepared candidate",
            )
    else:
        _write_json(MANUAL_RECEIPT, expected_manual)
    PREPARE_STATE.unlink(missing_ok=True)
    return candidate


def _package_identity() -> dict[str, str]:
    executable = PACKAGE_PATH / "Contents/MacOS/Voice2Text"
    worker_manifest = PACKAGE_PATH / "Contents/Resources/worker/manifest.json"
    _require(executable.is_file(), "packaged executable is missing")
    _require(worker_manifest.is_file(), "packaged worker manifest is missing")
    return {
        "path": PACKAGE_PATH.relative_to(ROOT).as_posix(),
        "manifestAlgorithm": "sorted-path-mode-content-sha256/v1",
        "manifestSha256": package_tree_sha256(PACKAGE_PATH),
        "executableSha256": _sha256_file(executable),
        "workerManifestSha256": _sha256_file(worker_manifest),
    }


def _validate_hashed_payload(value: dict[str, Any], label: str) -> None:
    recorded = value.get("sha256")
    _require(
        isinstance(recorded, str) and bool(SHA256.fullmatch(recorded)),
        f"{label} hash is invalid",
    )
    payload = {key: item for key, item in value.items() if key != "sha256"}
    _require(
        hashlib.sha256(_canonical(payload)).hexdigest() == recorded,
        f"{label} hash does not match its payload",
    )


def _validate_prepare_state(state: dict[str, Any]) -> None:
    _require(
        set(state)
        == {
            "schema",
            "status",
            "sourceRevision",
            "candidateInputsSha256",
            "productContractSha256",
            "target",
            "acquisitionMode",
            "executionEnvironment",
            "commandMatrixSha256",
            "startedAt",
            "automated",
            "package",
        },
        "prepare checkpoint fields are invalid",
    )
    _require(
        state.get("schema") == "voice2text-audio-sidebar-prepare-state/v1",
        "prepare checkpoint schema is invalid",
    )
    _require(
        state.get("status") == "PREPARING",
        "prepare checkpoint status is invalid",
    )
    for field in (
        "sourceRevision",
        "candidateInputsSha256",
        "productContractSha256",
        "commandMatrixSha256",
    ):
        value = state.get(field)
        pattern = REVISION if field == "sourceRevision" else SHA256
        _require(
            isinstance(value, str) and bool(pattern.fullmatch(value)),
            f"prepare checkpoint {field} is invalid",
        )
    _require(
        state.get("acquisitionMode") in {"cache-allowed", "force-fresh"},
        "prepare checkpoint acquisition mode is invalid",
    )
    target = state.get("target")
    _require(
        isinstance(target, dict)
        and set(target)
        == {
            "operatingSystem",
            "operatingSystemVersion",
            "architecture",
            "cpuModel",
            "logicalCpuCount",
            "memoryBytes",
            "sha256",
        },
        "prepare checkpoint target is invalid",
    )
    _validate_hashed_payload(target, "prepare checkpoint target")
    environment = state.get("executionEnvironment")
    _require(
        isinstance(environment, dict)
        and set(environment) == {"tools", "environment", "sha256"}
        and isinstance(environment.get("tools"), dict)
        and isinstance(environment.get("environment"), dict),
        "prepare checkpoint executionEnvironment is invalid",
    )
    expected_tool_names = {"bun", "dart", "flutter", "xcodebuild", "clang", "swift"}
    _require(
        set(environment["tools"]) == expected_tool_names
        and all(
            isinstance(tool, dict)
            and set(tool) == {"path", "version"}
            and all(isinstance(value, str) and value for value in tool.values())
            for tool in environment["tools"].values()
        ),
        "prepare checkpoint tools are invalid",
    )
    _require(
        set(environment["environment"])
        == {
            "CODE_SIGNING_ALLOWED",
            "DEVELOPMENT_TEAM",
            "EXPANDED_CODE_SIGN_IDENTITY",
            "RUN_PACKAGED_NATIVE_SECURITY_KEYCHAIN_MUTATION",
            "VOICE2TEXT_DART_EXECUTABLE",
            "VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD",
            "VOICE2TEXT_MACOS_SIGN_IDENTITY",
            "VOICE2TEXT_RESOURCE_CACHE_DIR",
            "VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB",
        }
        and all(
            value is None or isinstance(value, str)
            for value in environment["environment"].values()
        ),
        "prepare checkpoint environment is invalid",
    )
    _validate_hashed_payload(
        environment, "prepare checkpoint executionEnvironment"
    )
    _parse_utc_timestamp(state.get("startedAt"), "prepare checkpoint start time")
    automated = state.get("automated")
    _require(isinstance(automated, list), "prepare checkpoint results are invalid")
    _require(
        len(automated) <= len(PREPARE_COMMANDS),
        "prepare checkpoint result prefix is too long",
    )
    for result, (identifier, command, _cwd) in zip(
        automated, PREPARE_COMMANDS, strict=False
    ):
        _require(
            isinstance(result, dict)
            and set(result) == {"id", "command", "status", "elapsedMs"}
            and result.get("id") == identifier
            and result.get("command") == list(command)
            and result.get("status") == "PASS"
            and type(result.get("elapsedMs")) is int
            and result["elapsedMs"] >= 0,
            "prepare checkpoint results are not an exact PASS prefix",
        )
    package = state.get("package")
    package_index = next(
        (
            index
            for index, (identifier, _command, _cwd) in enumerate(PREPARE_COMMANDS)
            if identifier == "package-once"
        ),
        None,
    )
    package_has_passed = package_index is not None and len(automated) > package_index
    _require(
        package_has_passed == isinstance(package, dict),
        "prepare checkpoint package binding is inconsistent",
    )
    if isinstance(package, dict):
        _require(
            set(package)
            == {
                "path",
                "manifestAlgorithm",
                "manifestSha256",
                "executableSha256",
                "workerManifestSha256",
            }
            and all(
                isinstance(package.get(field), str)
                and bool(SHA256.fullmatch(package[field]))
                for field in (
                    "manifestSha256",
                    "executableSha256",
                    "workerManifestSha256",
                )
            ),
            "prepare checkpoint package identity is invalid",
        )
        _require(
            package.get("path") == PACKAGE_PATH.relative_to(ROOT).as_posix()
            and package.get("manifestAlgorithm")
            == "sorted-path-mode-content-sha256/v1",
            "prepare checkpoint package metadata is invalid",
        )


def _load_prepare_state() -> dict[str, Any]:
    try:
        state = _load(PREPARE_STATE, "prepare checkpoint")
    except (json.JSONDecodeError, OSError) as error:
        raise CandidateError("prepare checkpoint is malformed") from error
    _validate_prepare_state(state)
    return state


def _checkpoint_identity(
    *,
    source_revision: str,
    input_sha: str,
    product_contract_sha: str,
    target: dict[str, Any],
    environment: dict[str, Any],
) -> dict[str, Any]:
    return {
        "sourceRevision": source_revision,
        "candidateInputsSha256": input_sha,
        "productContractSha256": product_contract_sha,
        "target": target,
        "acquisitionMode": _resource_acquisition_mode(),
        "executionEnvironment": environment,
        "commandMatrixSha256": _command_matrix_sha256(),
    }


def _checkpoint_is_current(
    state: dict[str, Any], identity: dict[str, Any]
) -> bool:
    if any(state.get(field) != value for field, value in identity.items()):
        return False
    package = state.get("package")
    if isinstance(package, dict):
        try:
            return package == _package_identity()
        except CandidateError:
            return False
    return True


@_serialized_release_operation
def prepare(
    *,
    runner: Callable[[Sequence[str], pathlib.Path], None] = _run_command,
) -> dict[str, Any]:
    _require(not FINAL_RECEIPT.exists(), "candidate was already finalized")
    _validate_product_manifest()
    if CANDIDATE_RECEIPT.exists():
        return _recover_prepared_candidate()
    _require(
        not MANUAL_RECEIPT.exists(),
        "manual receipt exists without a candidate receipt",
    )
    source_revision, input_sha = committed_candidate_identity()
    product_contract_sha = _product_contract_sha256()
    target = target_fingerprint()
    environment = execution_environment_fingerprint()
    identity = _checkpoint_identity(
        source_revision=source_revision,
        input_sha=input_sha,
        product_contract_sha=product_contract_sha,
        target=target,
        environment=environment,
    )
    state: dict[str, Any]
    if PREPARE_STATE.exists():
        state = _load_prepare_state()
        if not _checkpoint_is_current(state, identity):
            PREPARE_STATE.unlink()
            state = {}
    else:
        state = {}
    if not state:
        state = {
            "schema": "voice2text-audio-sidebar-prepare-state/v1",
            "status": "PREPARING",
            **identity,
            "startedAt": _timestamp(),
            "automated": [],
            "package": None,
        }
    commands = state["automated"]
    for identifier, command, cwd in PREPARE_COMMANDS[len(commands) :]:
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
        if identifier == "package-once":
            state["package"] = _package_identity()
        _write_json(PREPARE_STATE, state)
    package = state.get("package")
    _require(isinstance(package, dict), "prepared package identity is missing")
    _require(package == _package_identity(), "prepared package identity changed")
    receipt = {
        "schema": "voice2text-audio-sidebar-candidate/v1",
        "status": "AUTOMATED_PASS_MANUAL_PENDING",
        "sourceRevision": source_revision,
        "candidateInputsSha256": input_sha,
        "productContractSha256": product_contract_sha,
        "preparedAt": state["startedAt"],
        "automatedFinishedAt": _timestamp(),
        "target": target,
        "package": package,
        "automated": commands,
    }
    manual = _pending_manual_receipt(receipt)
    _validate_candidate_receipt(receipt, package_already_verified=True)
    _write_json(CANDIDATE_RECEIPT, receipt)
    _write_json(MANUAL_RECEIPT, manual)
    PREPARE_STATE.unlink(missing_ok=True)
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
    started_at = _parse_utc_timestamp(manual.get("startedAt"), "manual start time")
    finished_at = _parse_utc_timestamp(manual.get("finishedAt"), "manual finish time")
    elapsed = manual.get("elapsedMs")
    _require(
        type(elapsed) is int
        and 0 < elapsed <= int(definition["maximumSessionMinutes"]) * 60_000,
        "manual elapsed time is invalid",
    )
    _require(finished_at >= started_at, "manual finish time precedes start time")
    measured_elapsed = round((finished_at - started_at).total_seconds() * 1000)
    _require(measured_elapsed == elapsed, "manual elapsed time does not match timestamps")
    checks = manual.get("checks")
    _require(isinstance(checks, list), "manual checks are missing")
    _require(
        checks == [{"id": identifier, "status": "PASS"} for identifier in required_ids],
        "manual checks are incomplete or reordered",
    )


def verify_candidate_identity(
    candidate: dict[str, Any], *, verify_package: bool = True
) -> None:
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
    if verify_package:
        _require(package_tree_sha256(PACKAGE_PATH) == expected, "candidate package changed")


def _expected_final_receipt(
    candidate: dict[str, Any], finalized_at: str
) -> dict[str, Any]:
    package = candidate["package"]
    return {
        "schema": "voice2text-audio-sidebar-final/v1",
        "status": "PASS",
        "sourceRevision": candidate["sourceRevision"],
        "candidateInputsSha256": candidate["candidateInputsSha256"],
        "productContractSha256": candidate["productContractSha256"],
        "packageManifestSha256": package["manifestSha256"],
        "targetSha256": candidate["target"]["sha256"],
        "candidateReceiptSha256": _sha256_file(CANDIDATE_RECEIPT),
        "manualReceiptSha256": _sha256_file(MANUAL_RECEIPT),
        "finalizedAt": finalized_at,
        "rebuildPerformed": False,
    }


def _recover_final_receipt(candidate: dict[str, Any]) -> dict[str, Any]:
    final = _load(FINAL_RECEIPT, "final receipt")
    finalized_at = final.get("finalizedAt")
    _parse_utc_timestamp(finalized_at, "finalized time")
    expected = _expected_final_receipt(candidate, str(finalized_at))
    _require(final == expected, "final receipt conflicts with candidate identity")
    return final


def _release_projection(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "PASS",
        "sourceRevision": candidate["sourceRevision"],
        "packageManifestSha256": candidate["package"]["manifestSha256"],
        "automatedReceipt": CANDIDATE_RECEIPT.relative_to(ROOT).as_posix(),
        "manualReceipt": MANUAL_RECEIPT.relative_to(ROOT).as_posix(),
        "finalizeRebuilds": False,
    }


def _project_final_product(candidate: dict[str, Any]) -> None:
    product = _load(PRODUCT_MANIFEST, "Audio/sidebar product manifest")
    expected = _release_projection(candidate)
    existing = product.get("releaseCandidate")
    if product.get("status") == "RELEASE_VALIDATED" or (
        isinstance(existing, dict) and existing.get("status") == "PASS"
    ):
        _require(
            product.get("status") == "RELEASE_VALIDATED" and existing == expected,
            "product projection conflicts with candidate identity",
        )
        return
    product["status"] = "RELEASE_VALIDATED"
    product["releaseCandidate"] = expected
    _write_json(PRODUCT_MANIFEST, product)


@_serialized_release_operation
def finalize() -> dict[str, Any]:
    _validate_product_manifest()
    candidate = _load(CANDIDATE_RECEIPT, "candidate receipt")
    _validate_candidate_receipt(candidate)
    manual = _load(MANUAL_RECEIPT, "manual receipt")
    validate_manual(candidate, manual)
    if FINAL_RECEIPT.exists():
        final = _recover_final_receipt(candidate)
    else:
        final = _expected_final_receipt(candidate, _timestamp())
        _write_json(FINAL_RECEIPT, final)
    _project_final_product(candidate)
    _validate_product_manifest()
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
