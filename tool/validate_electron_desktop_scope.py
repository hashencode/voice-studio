#!/usr/bin/env python3
"""Fail-closed validator for Electron desktop closure scope and evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCOPE = ROOT / "docs/product/desktop-electron-scope.json"
DEFAULT_EVIDENCE = ROOT / "docs/product/desktop-electron-evidence.json"

CAPABILITY_IDS = (
    "shell.navigation",
    "library.meetings",
    "library.import",
    "processing.tasks",
    "meeting.review",
    "capture.workspace",
    "capture.recovery",
    "captions.live",
    "settings.runtime",
    "settings.ai",
    "settings.security",
    "companion.pairing",
    "companion.transfer",
    "lifecycle.application",
    "accessibility.desktop",
)

ACCESSIBILITY_CHECK_IDS = (
    "keyboard",
    "focus",
    "voiceover",
    "minimum-window",
    "text-scaling-200-percent",
    "reduced-motion",
    "non-drag-alternatives",
)

EXPECTED_U12_TARGET = {
    "modelIdentifier": "Mac14,3",
    "operatingSystem": "macOS",
    "operatingSystemVersion": "15.7.5",
    "operatingSystemBuild": "24G624",
    "architecture": "arm64",
    "cpuModel": "Apple M2",
    "logicalCpuCount": 8,
    "memoryBytes": 17179869184,
    "buildMode": "development-package",
}

RELEVANT_SOURCE_PATHS = (
    "apps/desktop-electron",
    "packages/companion_protocol",
    "packages/desktop_macos_native",
    "packages/desktop_sherpa_worker",
    "docs/architecture/desktop-client-transition.md",
    "docs/product/desktop-electron-parity-baseline.json",
    "tool/check_electron_desktop.sh",
    "tool/test_validate_electron_desktop_scope.py",
    "tool/validate_electron_desktop_scope.py",
)

_SCOPE_FIELDS = {
    "$schema",
    "schema",
    "developmentPosture",
    "application",
    "referenceBaseline",
    "targets",
    "capabilities",
    "releaseExclusions",
}
_EVIDENCE_FIELDS = {
    "$schema",
    "schema",
    "unit",
    "status",
    "disposition",
    "developmentPosture",
    "capturedAt",
    "source",
    "target",
    "artifacts",
    "referenceBaseline",
    "evidenceBindings",
    "capabilityEvidence",
    "accessibility",
    "privacy",
    "validationSessions",
    "verification",
    "blockers",
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_PRIVACY_STATUS_KEYS = {
    "sensitiveKeyDetected",
    "fullSensitivePathDetected",
    "repositoryPathDetected",
    "rawAudioOrTranscriptDetected",
    "reusableTokenDetected",
    "secretCanaryDetected",
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
    _require(isinstance(value, str) and _SHA256.fullmatch(value) is not None, f"{label} is not sha256")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _json_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _load(path: Path, label: str) -> dict[str, Any]:
    _require(path.is_file(), f"{label} is missing")
    return _mapping(json.loads(path.read_text(encoding="utf-8")), label)


def _scan_sensitive_evidence(value: Any, *, root: Path, path: str = "evidence") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            lowered = key.lower()
            if key not in _PRIVACY_STATUS_KEYS and (
                lowered in {
                    "secret",
                    "token",
                    "credential",
                    "credentialbase64",
                    "transcripttext",
                    "utterances",
                    "audiopayload",
                    "rawaudio",
                }
                or lowered.endswith("secret")
                or lowered.endswith("token")
            ):
                raise ValueError(f"privacy-sensitive evidence key: {path}.{key}")
            _scan_sensitive_evidence(nested, root=root, path=f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _scan_sensitive_evidence(nested, root=root, path=f"{path}[{index}]")
    elif isinstance(value, str):
        _require(
            str(root) not in value
            and not value.startswith("/Users/")
            and "SECRET_CANARY" not in value,
            f"privacy-sensitive evidence value: {path}",
        )


def _safe_repository_path(
    root: Path,
    value: Any,
    label: str,
    *,
    directory: bool = False,
) -> Path:
    _require(isinstance(value, str) and value, f"{label} must be a path")
    relative = PurePosixPath(value)
    _require(not relative.is_absolute() and ".." not in relative.parts, f"{label} is unsafe")
    path = root.joinpath(*relative.parts)
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError(f"{label} contains a symlink")
    _require(path.is_dir() if directory else path.is_file(), f"{label} is missing: {value}")
    return path


def _bundle_manifest_sha256(bundle: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(bundle.rglob("*")):
        relative = path.relative_to(bundle).as_posix()
        if path.is_symlink():
            kind = "symlink"
            content = os.readlink(path).encode()
        elif path.is_file():
            kind = "file"
            content = _sha256(path).encode()
        else:
            continue
        digest.update(kind.encode())
        digest.update(b"\0")
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\n")
    return digest.hexdigest()


def _validate_capability_rows(rows: Any, label: str, *, allow_blocked: bool) -> dict[str, dict[str, Any]]:
    items = [_mapping(item, f"{label} item") for item in _array(rows, label)]
    identifiers = [item.get("id") for item in items]
    _require(len(identifiers) == len(set(identifiers)), f"{label} has duplicate capabilities")
    _require(set(identifiers) == set(CAPABILITY_IDS), f"{label} capability set is invalid")
    for item in items:
        _require(item.get("status") in ({"PASS", "BLOCKED"} if allow_blocked else {"PASS"}), f"{label} capability is not complete")
        bindings = item.get("evidenceBindingIds")
        _require(isinstance(bindings, list) and all(isinstance(value, str) and value for value in bindings), f"{label} evidence bindings are invalid")
    return {str(item["id"]): item for item in items}


def _validate_reference(
    reference: dict[str, Any],
    *,
    root: Path,
    expected_path: str,
    expected_sha: str,
    passing: bool,
) -> None:
    _require(reference.get("path") == expected_path, "reference baseline path mismatch")
    baseline_path = _safe_repository_path(root, reference.get("path"), "reference baseline")
    _require(_sha256(baseline_path) == _sha(reference.get("sha256"), "baseline hash"), "baseline hash drift")
    _require(reference.get("sha256") == expected_sha, "scope and evidence baseline hash mismatch")
    baseline = _load(baseline_path, "reference baseline")
    expected_base = _mapping(baseline.get("referenceChangePolicy"), "reference change policy").get("comparisonBaseRevision")
    _require(reference.get("comparisonBaseRevision") == expected_base, "reference comparison base drift")
    frozen = _array(reference.get("frozenFiles"), "frozen reference files")
    baseline_fixtures = {
        item.get("path"): item.get("sha256")
        for item in _array(baseline.get("fixtures"), "baseline fixtures")
        if isinstance(item, dict)
    }
    _require({item.get("path") for item in frozen if isinstance(item, dict)} == set(baseline_fixtures), "frozen reference file set drift")
    for raw in frozen:
        item = _mapping(raw, "frozen reference file")
        path = _safe_repository_path(root, item.get("path"), "frozen reference file")
        actual = _sha256(path)
        _require(actual == _sha(item.get("sha256"), "frozen reference hash") == baseline_fixtures.get(item.get("path")), "frozen reference hash drift")
    _require(reference.get("flutterDesktopLaunched") is False, "Flutter Desktop launch is prohibited")
    _require(reference.get("flutterRuntimeProfileInspected") is False, "Flutter runtime profile inspection is prohibited")
    changes = _array(reference.get("laterChanges"), "reference changes")
    allowed = set(_mapping(baseline.get("referenceChangePolicy"), "reference change policy").get("allowedDispositions", []))
    for raw in changes:
        change = _mapping(raw, "reference change")
        _require(change.get("disposition") in allowed, "reference change disposition is invalid")
        evidence = change.get("electronEvidence")
        _require(isinstance(evidence, list), "reference change evidence is invalid")
        if passing:
            _require(change.get("disposition") == "adopted-with-electron-evidence" and evidence, "reference change blocks Electron closure")


def _run_git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _relevant_source_sha256(root: Path, revision: str) -> str:
    result = subprocess.run(
        [
            "git",
            "ls-tree",
            "-r",
            "--full-tree",
            revision,
            "--",
            *RELEVANT_SOURCE_PATHS,
        ],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def validate_electron_desktop_scope(
    scope_path: Path = DEFAULT_SCOPE,
    *,
    evidence_path: Path = DEFAULT_EVIDENCE,
    root: Path = ROOT,
    validate_repository: bool = True,
    current_target: dict[str, Any] | None = None,
    allow_blocked: bool = False,
) -> dict[str, Any]:
    root = root.resolve()
    scope = _load(scope_path, "Electron desktop scope")
    evidence = _load(evidence_path, "Electron desktop evidence")
    _scan_sensitive_evidence(evidence, root=root)
    _exact_fields(scope, _SCOPE_FIELDS, "scope")
    _exact_fields(evidence, _EVIDENCE_FIELDS, "evidence")
    _require(scope.get("schema") == "voice2text-desktop-electron-scope/v1", "scope schema mismatch")
    _require(evidence.get("schema") == "voice2text-desktop-electron-evidence/v1", "evidence schema mismatch")
    _require(evidence.get("unit") == "U12", "evidence unit mismatch")
    _require(scope.get("developmentPosture") == evidence.get("developmentPosture") == "DEVELOPMENT_ONLY", "DEVELOPMENT_ONLY posture is required")

    application = _mapping(scope.get("application"), "application")
    _require(application == {
        "compositionRoot": "apps/desktop-electron",
        "packageManager": "bun",
        "rendererBuild": "vite",
        "desktopPackaging": "electron-forge",
        "rendererStack": "react-typescript-shadcn-tailwind-sidebar-07",
        "flutterRuntimeFallback": False,
        "sharedRuntimeDatabase": False,
    }, "application boundary drift")

    targets = _mapping(scope.get("targets"), "targets")
    _require(set(targets) == {"macos", "windows"}, "target field set is invalid")
    macos = _mapping(targets.get("macos"), "macOS target")
    windows = _mapping(targets.get("windows"), "Windows target")
    passing = macos.get("status") == "PASS"
    _require(passing or (allow_blocked and macos.get("status") == "BLOCKED"), "macOS closure is blocked")
    expected_disposition = "MACOS_ELECTRON_CLOSED_FOR_WINDOWS_ENTRY" if passing else "MACOS_ELECTRON_CLOSURE_BLOCKED"
    _require(macos.get("closureDisposition") == expected_disposition, "macOS disposition mismatch")
    _require(windows.get("inheritsMacosPass") is False, "Windows cannot inherit macOS PASS")
    _require(windows.get("evidence") is None, "Windows evidence must be independent")
    expected_windows = "READY_FOR_INDEPENDENT_U13" if passing else "BLOCKED_BY_MACOS_CLOSURE"
    _require(windows.get("status") == expected_windows and windows.get("status") != "PASS", "Windows cannot claim PASS at U12")

    scope_capabilities = _validate_capability_rows(scope.get("capabilities"), "scope capabilities", allow_blocked=not passing)
    evidence_capabilities = _validate_capability_rows(evidence.get("capabilityEvidence"), "evidence capabilities", allow_blocked=not passing)
    for identifier in CAPABILITY_IDS:
        _require(scope_capabilities[identifier] == evidence_capabilities[identifier], f"capability evidence mismatch: {identifier}")

    evidence_binding = _mapping(macos.get("evidence"), "macOS evidence binding")
    bound_evidence_path = _safe_repository_path(root, evidence_binding.get("path"), "macOS evidence")
    _require(bound_evidence_path == evidence_path.resolve(), "macOS evidence path mismatch")
    _require(_sha256(bound_evidence_path) == _sha(evidence_binding.get("sha256"), "evidence hash"), "evidence hash drift")

    release = _mapping(scope.get("releaseExclusions"), "release exclusions")
    _require(release == {
        "maximumValidationSessionMinutes": 30,
        "productionNotarization": False,
        "automaticUpdates": False,
        "storeSubmission": False,
        "releaseCandidateDeviceMatrix": False,
    }, "DEVELOPMENT_ONLY release exclusions drift")

    source = _mapping(evidence.get("source"), "source")
    _require(_REVISION.fullmatch(str(source.get("revision", ""))) is not None, "source revision is invalid")
    _require(_REVISION.fullmatch(str(source.get("tree", ""))) is not None, "source tree is invalid")
    _sha(source.get("relevantSourceSha256"), "relevant source hash")
    for field, label in (("packageManifest", "package manifest"), ("dependencyLock", "dependency lock")):
        binding = _mapping(source.get(field), label)
        path = _safe_repository_path(root, binding.get("path"), label)
        _require(_sha256(path) == _sha(binding.get("sha256"), f"{label} hash"), f"{label} hash drift")

    target = _mapping(evidence.get("target"), "target")
    _require(
        target == (current_target or EXPECTED_U12_TARGET),
        "target fingerprint mismatch",
    )
    target_hash = _json_sha256(target)

    artifacts = _mapping(evidence.get("artifacts"), "artifacts")
    if passing:
        _require(artifacts.get("status") == "PASS", "artifact evidence is incomplete")
    bundle = _mapping(artifacts.get("bundle"), "bundle")
    bundle_path = _safe_repository_path(root, bundle.get("path"), "bundle", directory=True)
    _require(bundle.get("hashScheme") == "sorted-bundle-manifest-v1", "bundle hash scheme drift")
    bundle_hash = _bundle_manifest_sha256(bundle_path)
    _require(bundle_hash == _sha(bundle.get("manifestSha256"), "bundle manifest hash"), "bundle manifest hash drift")
    bindings = [_mapping(item, "artifact binding") for item in _array(artifacts.get("bindings"), "artifact bindings")]
    identifiers = [item.get("id") for item in bindings]
    _require(len(identifiers) == len(set(identifiers)), "artifact binding IDs must be unique")
    required_kinds = {"application", "renderer", "helper", "worker", "runtime", "manifest", "model"}
    _require(required_kinds <= {item.get("kind") for item in bindings}, "artifact classes are incomplete")
    artifacts_by_id = {str(item.get("id")): item for item in bindings}
    for item in bindings:
        path = _safe_repository_path(root, item.get("path"), f"artifact {item.get('id')}")
        _require(_sha256(path) == _sha(item.get("sha256"), "artifact hash"), f"artifact hash drift: {item.get('id')}")
        if item.get("kind") not in {"application", "renderer"}:
            _require(item.get("outsideAsar") is True, "helper/worker/runtime/model must remain outside ASAR")
    signing = _mapping(artifacts.get("signing"), "signing")
    entitlements = _safe_repository_path(root, signing.get("helperEntitlementsPath"), "helper entitlements")
    _require(_sha256(entitlements) == _sha(signing.get("helperEntitlementsSha256"), "helper entitlements hash"), "helper entitlements hash drift")
    if passing:
        _require(signing.get("appVerification") == signing.get("helperVerification") == "PASS", "development codesign verification failed")
    isolation = _mapping(artifacts.get("runtimeIsolation"), "packaged runtime isolation")
    _require(isolation.get("rendererUrlScheme") == "file", "packaged runtime must use file assets")
    _require(isolation.get("allExecutablesOutsideAsar") is True, "packaged executables entered ASAR")
    for field in ("viteDevelopmentServerUsed", "repositoryPathUsedByPackagedApp", "flutterBuildOutputUsed", "pubCacheUsed"):
        _require(isolation.get(field) is False, "packaged runtime used a prohibited development path")

    scope_reference = _mapping(scope.get("referenceBaseline"), "scope reference baseline")
    reference = _mapping(evidence.get("referenceBaseline"), "evidence reference baseline")
    _require(scope_reference.get("runtimeUse") == "reference-only", "Flutter reference runtime use drift")
    _require(scope_reference.get("prohibitedActions") == [
        "launch-flutter-desktop",
        "inspect-flutter-runtime-profile",
        "copy-or-migrate-flutter-runtime-profile",
        "use-flutter-as-runtime-fallback",
    ], "Flutter reference prohibited actions drift")
    _validate_reference(reference, root=root, expected_path=str(scope_reference.get("path")), expected_sha=str(scope_reference.get("sha256")), passing=passing)

    raw_bindings = [_mapping(item, "evidence binding") for item in _array(evidence.get("evidenceBindings"), "evidence bindings")]
    binding_ids = [item.get("id") for item in raw_bindings]
    _require(len(binding_ids) == len(set(binding_ids)), "evidence binding IDs must be unique")
    evidence_bindings = {str(item.get("id")): item for item in raw_bindings}
    for item in raw_bindings:
        if passing and item.get("mode") != "bounded-manual":
            _require(item.get("status") == "PASS", "evidence binding is not complete")
        _require(item.get("targetFingerprintSha256") == target_hash, "manual target binding mismatch" if item.get("mode") == "bounded-manual" else "target binding mismatch")
        _require(item.get("packageManifestSha256") == bundle_hash, "manual package binding mismatch" if item.get("mode") == "bounded-manual" else "package binding mismatch")
        elapsed = item.get("elapsedMilliseconds")
        _require(isinstance(elapsed, int) and elapsed >= 0, "evidence elapsed time is invalid")
        if item.get("mode") == "automated":
            path = _safe_repository_path(root, item.get("path"), "automated evidence")
            _require(_sha256(path) == _sha(item.get("sha256"), "automated evidence hash"), "automated evidence hash drift")
        elif item.get("mode") == "bounded-manual":
            _require(isinstance(item.get("procedureId"), str) and item.get("procedureId"), "manual procedure is missing")
            maximum = item.get("maximumMinutes")
            _require(isinstance(maximum, int) and 0 < maximum <= 30 and elapsed <= maximum * 60_000, "manual evidence exceeds its bound")
            if passing:
                _require(item.get("status") == "PASS", "manual evidence is not complete")
            else:
                _require(
                    item.get("status") in {"PASS", "NOT_RUN"},
                    "manual evidence status is invalid",
                )
        else:
            raise ValueError("evidence binding mode is invalid")
    for item in evidence_capabilities.values():
        _require(all(value in evidence_bindings for value in item["evidenceBindingIds"]), "capability references missing evidence")

    accessibility = _mapping(evidence.get("accessibility"), "accessibility")
    checks = [_mapping(item, "accessibility check") for item in _array(accessibility.get("checks"), "accessibility checks")]
    _require({item.get("id") for item in checks} == set(ACCESSIBILITY_CHECK_IDS) and len(checks) == len(ACCESSIBILITY_CHECK_IDS), "accessibility check set is invalid")
    if passing:
        _require(accessibility.get("status") == "PASS" and all(item.get("status") == "PASS" for item in checks), "accessibility evidence is incomplete")
    for item in checks:
        _require(all(value in evidence_bindings for value in item.get("evidenceBindingIds", [])), "accessibility evidence binding is missing")

    privacy = _mapping(evidence.get("privacy"), "privacy")
    privacy_flags = ("sensitiveKeyDetected", "fullSensitivePathDetected", "repositoryPathDetected", "rawAudioOrTranscriptDetected", "reusableTokenDetected", "secretCanaryDetected")
    if passing:
        _require(privacy.get("status") == "PASS" and privacy.get("schemaAllowlistEnforced") is True, "privacy validation is incomplete")
    _require(all(privacy.get(field) is False for field in privacy_flags), "privacy finding detected")
    _require(set(privacy.get("scannedEvidenceBindingIds", [])) == set(evidence_bindings), "privacy scan coverage is incomplete")

    for session in _array(evidence.get("validationSessions"), "validation sessions"):
        item = _mapping(session, "validation session")
        elapsed = item.get("elapsedMilliseconds")
        maximum = item.get("maximumMilliseconds")
        _require(isinstance(elapsed, int) and isinstance(maximum, int) and elapsed <= maximum <= 1_800_000, "validation session exceeds 30 minutes")
        if passing:
            _require(item.get("status") == "PASS", "validation session did not pass")

    verification = _mapping(evidence.get("verification"), "verification")
    if passing:
        required = ("electronStaticAndUnit", "packagedMacos", "packagedProductFlows", "artifactInspection", "privacy", "accessibility", "rootDevCheck", "uiWatcher")
        _require(all(verification.get(field) == "PASS" for field in required), "root dev_check or required verification did not pass")
        _require(evidence.get("status") == "PASS" and evidence.get("disposition") == expected_disposition and evidence.get("blockers") == [], "PASS evidence disposition is inconsistent")
    else:
        _require(evidence.get("status") == "BLOCKED" and evidence.get("blockers"), "blocked evidence must name blockers")

    if validate_repository:
        revision = str(source.get("revision"))
        tree = str(source.get("tree"))
        _require(_run_git(root, "cat-file", "-t", revision) == "commit", "source revision is not a commit")
        _require(_run_git(root, "show", "-s", "--format=%T", revision) == tree, "source tree drift")
        _require(
            _relevant_source_sha256(root, revision)
            == source.get("relevantSourceSha256"),
            "relevant source hash drift",
        )
        ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", revision, "HEAD"], cwd=root)
        _require(ancestry.returncode == 0, "source revision is not an ancestor of HEAD")
        if signing.get("appVerification") == "PASS":
            subprocess.run(
                ["codesign", "--verify", "--deep", "--strict", str(bundle_path)],
                cwd=root,
                check=True,
                capture_output=True,
            )
        if signing.get("helperVerification") == "PASS":
            helper_path = _safe_repository_path(
                root,
                _mapping(artifacts_by_id.get("native-helper"), "native helper").get("path"),
                "native helper",
            )
            subprocess.run(
                ["codesign", "--verify", "--strict", str(helper_path)],
                cwd=root,
                check=True,
                capture_output=True,
            )
        app_asar = _safe_repository_path(
            root,
            _mapping(artifacts_by_id.get("app-asar"), "app ASAR").get("path"),
            "app ASAR",
        )
        _require(
            b'require("node:sqlite")' in app_asar.read_bytes(),
            "packaged Main does not externalize node:sqlite",
        )

    return {"target": "macos", "status": "PASS" if passing else "BLOCKED", "disposition": expected_disposition}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", type=Path, default=DEFAULT_SCOPE)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--allow-blocked", action="store_true")
    arguments = parser.parse_args()
    result = validate_electron_desktop_scope(arguments.scope, evidence_path=arguments.evidence, allow_blocked=arguments.allow_blocked)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
