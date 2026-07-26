#!/usr/bin/env python3
"""Validate the desktop-first workstation product truth."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs/product/desktop-workstation-scope.json"
DECISION_ID = "DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26"
EXPECTED_DOCUMENTS = {
    "docs/product/meeting-voice-recognition-prd-v1.0.md": {
        DECISION_ID,
        "PLANNED",
        "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
    },
    "docs/product/mobile-capability-matrix.md": {
        DECISION_ID,
        "桌面主工作站",
        "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
    },
    "docs/product/s3-productization-status.md": {
        DECISION_ID,
        "桌面主工作站",
        "PLANNED",
    },
    "docs/product/desktop-workstation-status.md": {
        DECISION_ID,
        "PLANNED",
        "TARGET_SPECIFIC",
    },
}
TARGET_STATUSES = {
    "android": {"MOBILE_CORE_AVAILABLE"},
    "macos": {
        "PLANNED",
        "FOUNDATION_IN_PROGRESS",
        "BENCHMARK_IN_PROGRESS",
        "FINALISTS_FROZEN",
        "PRODUCT_IN_PROGRESS",
        "PASS",
        "NO_ADMISSIBLE_ENGINE",
    },
    "windows": {
        "BLOCKED_BY_MACOS_CLOSURE",
        "PLANNED",
        "IN_PROGRESS",
        "PASS",
        "WINDOWS_NO_ADMISSIBLE_FINALIST",
    },
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN_ASR005_PATTERNS = (
    re.compile(r"development blockers?[^.\n]*ASR-005", re.IGNORECASE),
    re.compile(r"ASR-005[^.\n]*development blockers?", re.IGNORECASE),
    re.compile(r"daily reminders?[^.\n]*ASR-005", re.IGNORECASE),
    re.compile(r"ASR-005[^.\n]*daily reminders?", re.IGNORECASE),
    re.compile(r"开发阻塞[^。\n]*ASR-005"),
    re.compile(r"ASR-005[^。\n]*开发阻塞"),
    re.compile(r"日常提醒[^。\n]*ASR-005"),
    re.compile(r"ASR-005[^。\n]*日常提醒"),
)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _safe_path(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value), f"{label} must be a path")
    path = PurePosixPath(value)
    _require(not path.is_absolute() and ".." not in path.parts, f"{label} is unsafe")
    return value


def validate_asr005_policy_text(text: str, label: str) -> None:
    """Reject active development reminders while allowing the user-owned policy."""
    if "ASR-005" not in text:
        return
    for line in text.splitlines():
        if "ASR-005" not in line:
            continue
        if "USER_PRE_RELEASE_ACCEPTANCE_ONLY" in line:
            continue
        for pattern in FORBIDDEN_ASR005_PATTERNS:
            _require(
                pattern.search(line) is None,
                f"{label} returns ASR-005 to development blockers or reminders",
            )


def _validate_target_evidence(targets: dict[str, Any]) -> None:
    owners_by_hash: dict[str, set[str]] = {}
    for target_name, target in targets.items():
        _require(
            target.get("evidencePolicy") == "TARGET_SPECIFIC",
            f"{target_name} evidence must be TARGET_SPECIFIC",
        )
        evidence_items = target.get("evidence")
        _require(isinstance(evidence_items, list), f"{target_name}.evidence must be an array")
        for index, raw in enumerate(evidence_items):
            evidence = _mapping(raw, f"{target_name}.evidence[{index}]")
            _safe_path(evidence.get("path"), f"{target_name}.evidence[{index}].path")
            digest = evidence.get("sha256")
            _require(
                isinstance(digest, str) and SHA256_PATTERN.fullmatch(digest) is not None,
                f"{target_name}.evidence[{index}].sha256 is invalid",
            )
            owners_by_hash.setdefault(digest, set()).add(target_name)
    reused = {
        digest: sorted(owners)
        for digest, owners in owners_by_hash.items()
        if len(owners) > 1
    }
    _require(not reused, f"evidence hash reused across targets: {reused}")


def _validate_documents(manifest: dict[str, Any], root: Path) -> None:
    raw_documents = manifest.get("authoritativeDocuments")
    _require(isinstance(raw_documents, list), "authoritativeDocuments must be an array")
    actual: dict[str, set[str]] = {}
    for index, raw in enumerate(raw_documents):
        document = _mapping(raw, f"authoritativeDocuments[{index}]")
        path = _safe_path(document.get("path"), "document.path")
        markers = document.get("requiredMarkers")
        _require(
            isinstance(markers, list) and all(isinstance(marker, str) for marker in markers),
            f"{path} markers invalid",
        )
        actual[path] = set(markers)
    _require(actual == EXPECTED_DOCUMENTS, "authoritative document marker contract changed")
    for relative_path, markers in actual.items():
        text = (root / relative_path).read_text(encoding="utf-8")
        for marker in markers:
            _require(marker in text, f"{relative_path} missing required marker: {marker}")
        _require(
            "ASR-005-TIMESTAMP-INDEPENDENT" not in text
            and "SKIPPED_PENDING_USER_TEST" not in text,
            f"{relative_path} retains an ASR-005 development reminder",
        )
        validate_asr005_policy_text(text, relative_path)


def validate_scope_contract(
    manifest_path: Path = DEFAULT_MANIFEST,
    root: Path = ROOT,
    *,
    validate_documents: bool = True,
) -> dict[str, str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    _require(manifest.get("schemaVersion") == 1, "schemaVersion must be 1")
    _require(manifest.get("decisionId") == DECISION_ID, "decisionId mismatch")

    direction = _mapping(manifest.get("productDirection"), "productDirection")
    _require(direction.get("workstation") == "desktop", "desktop must be the workstation")
    _require(
        direction.get("mobileRole") == "capture_and_independent_mobile_core",
        "mobile role mismatch",
    )
    _require(direction.get("firstDesktopTarget") == "macos", "macOS must be first")
    _require(
        direction.get("platformExecution") == "SERIAL_MACOS_THEN_WINDOWS",
        "platform execution must be macOS before Windows",
    )
    _require(
        direction.get("repositoryStrategy") == "MONOREPO_KEEP_ROOT_MOBILE",
        "repository strategy mismatch",
    )

    diagnostic = _mapping(
        manifest.get("mobileDiarizationFinalDiagnostic"),
        "mobileDiarizationFinalDiagnostic",
    )
    allowed_diagnostic_statuses = {
        "PENDING_FINAL_DIAGNOSTIC",
        "PASS_ADMISSIBLE",
        "FAIL_NO_ADMISSIBLE_CANDIDATE",
    }
    _require(
        diagnostic.get("status") in allowed_diagnostic_statuses,
        "mobile diagnostic status is invalid",
    )
    _require(diagnostic.get("singleRunOnly") is True, "mobile diagnostic must be single-run")
    _require(
        diagnostic.get("autoContinueCandidates") is False,
        "mobile diagnostic cannot reopen the candidate loop",
    )
    _require(
        diagnostic.get("terminalStatuses")
        == ["PASS_ADMISSIBLE", "FAIL_NO_ADMISSIBLE_CANDIDATE"],
        "mobile diagnostic terminal statuses changed",
    )
    if diagnostic.get("status") != "PENDING_FINAL_DIAGNOSTIC":
        contract_path = root / _safe_path(
            diagnostic.get("contractPath"),
            "mobileDiarizationFinalDiagnostic.contractPath",
        )
        summary_path = root / _safe_path(
            diagnostic.get("summaryPath"),
            "mobileDiarizationFinalDiagnostic.summaryPath",
        )
        summary_digest = diagnostic.get("summarySha256")
        _require(
            isinstance(summary_digest, str)
            and SHA256_PATTERN.fullmatch(summary_digest) is not None,
            "mobile diagnostic summary hash is invalid",
        )
        _require(contract_path.is_file(), "mobile diagnostic contract is missing")
        summary_bytes = summary_path.read_bytes()
        _require(
            hashlib.sha256(summary_bytes).hexdigest() == summary_digest,
            "mobile diagnostic summary hash mismatch",
        )
        summary = json.loads(summary_bytes)
        expected_summary_status = {
            "PASS_ADMISSIBLE": "MOBILE_DIARIZATION_ADMISSIBLE",
            "FAIL_NO_ADMISSIBLE_CANDIDATE": (
                "MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE"
            ),
        }[diagnostic["status"]]
        _require(
            summary.get("terminalDisposition") == expected_summary_status
            and summary.get("nextCandidate") is None,
            "mobile diagnostic summary disposition mismatch",
        )

    targets = _mapping(manifest.get("targets"), "targets")
    _require(set(targets) == {"android", "macos", "windows"}, "target set mismatch")
    for target_name, allowed_statuses in TARGET_STATUSES.items():
        target = _mapping(targets.get(target_name), f"targets.{target_name}")
        _require(
            target.get("status") in allowed_statuses,
            f"{target_name} status is invalid",
        )
    macos = targets["macos"]
    _require(macos.get("closureStatus") in {"NOT_RUN", "PASS", "FAIL"}, "macOS closure invalid")
    _require(
        (macos.get("status") == "PASS") == (macos.get("closureStatus") == "PASS"),
        "macOS product PASS and closure PASS must agree",
    )
    engines = _mapping(macos.get("firstRoundEngines"), "macOS firstRoundEngines")
    _require(engines.get("asr") == ["sherpa", "funasr"], "macOS ASR candidates changed")
    _require(
        engines.get("diarization") == ["sherpa", "pyannote.audio"],
        "macOS diarization candidates changed",
    )
    _require(
        engines.get("excluded") == ["whisper", "faster-whisper", "whisper.cpp"],
        "first-round excluded engines changed",
    )
    if macos.get("status") in {
        "FINALISTS_FROZEN",
        "PRODUCT_IN_PROGRESS",
        "PASS",
    }:
        frozen = _mapping(macos.get("frozenEngines"), "macOS frozenEngines")
        _require(
            frozen
            == {
                "asr": "sherpa-streaming-zipformer-zh-14m-2023-02-23",
                "diarization": "sherpa-pyannote-3.0-3dspeaker",
                "runtime": "sherpa-onnx-c-api@1.13.4",
                "boundary": "native_worker_process_group",
                "machineDecision": (
                    "benchmark/desktop/desktop_model_candidates.json"
                ),
            },
            "macOS frozen engine set changed",
        )
        decision = json.loads(
            (
                root
                / _safe_path(
                    frozen["machineDecision"],
                    "targets.macos.frozenEngines.machineDecision",
                )
            ).read_text(encoding="utf-8")
        ).get("machineDecision")
        _require(
            isinstance(decision, dict)
            and decision.get("winners")
            == {
                "asr": frozen["asr"],
                "diarization": frozen["diarization"],
            }
            and decision.get("selectedRuntime") == frozen["runtime"]
            and decision.get("selectedBoundary") == frozen["boundary"],
            "macOS frozen engines disagree with machine decision",
        )

    windows = targets["windows"]
    _require(
        windows.get("dependsOn") == "macos.closureStatus=PASS",
        "Windows dependency changed",
    )
    _require(windows.get("retestOnlyMacosFinalists") is True, "Windows must retest finalists")
    _require(windows.get("inheritsPassFromMacos") is False, "Windows cannot inherit PASS")
    if windows.get("status") != "BLOCKED_BY_MACOS_CLOSURE":
        _require(
            macos.get("closureStatus") == "PASS",
            "Windows work requires macOS closure PASS evidence",
        )
    _validate_target_evidence(targets)

    evidence_contract = _mapping(
        manifest.get("modelEvidenceContract"),
        "modelEvidenceContract",
    )
    _require(evidence_contract.get("targetSpecific") is True, "target evidence isolation required")
    _require(
        evidence_contract.get("crossTargetPassInheritance") is False,
        "cross-target PASS inheritance is forbidden",
    )

    lan = _mapping(manifest.get("lanHandoff"), "lanHandoff")
    lan_status = lan.get("status")
    _require(
        lan_status
        in {
            "BLOCKED_BY_MACOS_LOCAL_WORKSTATION",
            "PASS_MACOS_ANDROID_LAN",
        },
        "LAN status is invalid",
    )
    for field in (
        "requiresAuthentication",
        "requiresEncryption",
        "requiresResumableTransfer",
        "requiresReceiptBeforeSourceDeletion",
    ):
        _require(lan.get(field) is True, f"lanHandoff.{field} must be true")
    if lan_status == "PASS_MACOS_ANDROID_LAN":
        _require(
            lan.get("protocolSchema") == "companion-media-transfer/v1",
            "LAN PASS requires companion-media-transfer/v1",
        )
        evidence = _mapping(lan.get("evidence"), "lanHandoff.evidence")
        evidence_path = _safe_path(
            evidence.get("path"),
            "lanHandoff.evidence.path",
        )
        _require(
            evidence_path
            == "docs/product/desktop-workstation-u8-evidence.json",
            "LAN PASS evidence path changed",
        )
        evidence_digest = evidence.get("sha256")
        _require(
            isinstance(evidence_digest, str)
            and SHA256_PATTERN.fullmatch(evidence_digest) is not None,
            "LAN PASS evidence hash is invalid",
        )
        evidence_bytes = (root / evidence_path).read_bytes()
        _require(
            hashlib.sha256(evidence_bytes).hexdigest() == evidence_digest,
            "LAN PASS evidence hash mismatch",
        )
        lan_evidence = _mapping(
            json.loads(evidence_bytes),
            "LAN PASS evidence",
        )
        physical = _mapping(
            lan_evidence.get("physicalLanSmoke"),
            "LAN PASS physical smoke",
        )
        capture = _mapping(
            lan_evidence.get("encryptedCaptureInspection"),
            "LAN PASS capture inspection",
        )
        _require(
            lan_evidence.get("status") == "PASS_MACOS_ANDROID_LAN"
            and physical.get("result") == "PASS"
            and physical.get("sourceSha256")
            == physical.get("committedSha256")
            and physical.get("duplicateReturnedSameReceipt") is True
            and physical.get("phoneSourceRetained") is True,
            "LAN PASS physical smoke evidence is incomplete",
        )
        _require(
            capture.get("plaintextMeetingContentSeen") is False
            and capture.get("reusableCredentialSeen") is False,
            "LAN PASS capture inspection found plaintext or credentials",
        )

    asr005 = _mapping(manifest.get("asr005"), "asr005")
    _require(
        asr005.get("status") == "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
        "ASR-005 must be user-owned pre-release acceptance only",
    )
    _require(asr005.get("owner") == "user", "ASR-005 owner must be user")
    _require(asr005.get("developmentBlocker") is False, "ASR-005 cannot block development")
    _require(asr005.get("automatedReminder") is False, "ASR-005 cannot be an automated reminder")

    transition = _mapping(manifest.get("s3Transition"), "s3Transition")
    _require(
        transition.get("status") == "SUPERSEDED_BY_DESKTOP_WORKSTATION_DIRECTION",
        "S3 desktop transition status mismatch",
    )
    s3_scope_path = root / _safe_path(transition.get("scopePath"), "s3Transition.scopePath")
    s3_scope = json.loads(s3_scope_path.read_text(encoding="utf-8"))
    s3_desktop = _mapping(s3_scope.get("desktopWorkstationTransition"), "S3 desktop transition")
    _require(s3_desktop.get("decisionId") == DECISION_ID, "S3 transition decision mismatch")
    _require(s3_desktop.get("status") == "ACTIVE", "S3 transition must be ACTIVE")

    if validate_documents:
        _validate_documents(manifest, root)

    return {
        "firstDesktopTarget": direction["firstDesktopTarget"],
        "mobileDiarizationFinalDiagnostic": diagnostic["status"],
        "macos": macos["status"],
        "windows": windows["status"],
        "lanHandoff": lan_status,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", nargs="?", default=str(DEFAULT_MANIFEST))
    args = parser.parse_args()
    try:
        result = validate_scope_contract(Path(args.manifest), ROOT)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print("PASS: desktop workstation product truth is internally consistent")
    for key, value in result.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
