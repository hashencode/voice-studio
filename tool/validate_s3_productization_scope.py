#!/usr/bin/env python3
"""Validate S3 product truth without promoting conditional capabilities."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs/product/s3-productization-scope.json"
DECISION_ID = "S3-PRODUCTIZATION-2026-07-25"
EXPECTED_DOCUMENTS = {
    "README.md": {DECISION_ID, "PARTIAL_PASS", "NOT RELEASE-READY"},
    "docs/product/meeting-voice-recognition-prd-v1.0.md": {
        DECISION_ID,
        "DEFERRED_NO_ADMISSIBLE_CANDIDATE",
        "DEFERRED_PC_RUNTIME_MISSING",
        "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
    },
    "docs/product/mobile-capability-matrix.md": {
        DECISION_ID,
        "cloudDirect",
        "DEFERRED_NO_ADMISSIBLE_CANDIDATE",
        "DEFERRED_PC_RUNTIME_MISSING",
    },
    "docs/REAL_DEVICE_REGRESSION_MATRIX.md": {
        DECISION_ID,
        "DEFERRED_NO_ADMISSIBLE_CANDIDATE",
        "SKIPPED_BY_PLAN",
        "NOT RELEASE-READY",
    },
    "docs/product/s3-productization-status.md": {
        DECISION_ID,
        "PARTIAL_PASS",
        "DEFERRED_NO_ADMISSIBLE_CANDIDATE",
        "DEFERRED_PC_RUNTIME_MISSING",
        "PLANNED",
        "NOT RELEASE-READY",
    },
}
DIAGNOSTIC_SECRET_PATTERN = re.compile(
    r"(sk-[A-Za-z0-9]{20,}|Authorization\s*[:=]\s*Bearer|"
    r"api[_-]?key\s*[:=]|full[_-]?prompt\s*[:=])",
    re.IGNORECASE,
)


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reject_secret_bearing_diagnostics(text: str) -> None:
    if DIAGNOSTIC_SECRET_PATTERN.search(text):
        raise ValueError("diagnostics contain a secret, header, or full prompt")


def validate_scope_contract(
    manifest_path: Path = DEFAULT_MANIFEST,
    root: Path = ROOT,
    *,
    validate_documents: bool = True,
) -> dict[str, str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    _require(manifest.get("schemaVersion") == 2, "schemaVersion must be 2")
    _require(manifest.get("decisionId") == DECISION_ID, "decisionId mismatch")

    cloud = _mapping(manifest.get("cloudDirect"), "cloudDirect")
    _require(cloud.get("status") == "PASS", "cloudDirect must be PASS")
    _require(cloud.get("processingLocation") == "cloudDirect", "cloud location mismatch")
    for field in ("secureSecretStore", "explicitPerMeetingConsent", "boundedPersistentJobs"):
        _require(cloud.get(field) is True, f"cloudDirect.{field} must be true")
    _require(
        cloud.get("liveSmoke") == "OPTIONAL_NOT_RUN",
        "live smoke must remain optional and non-authoritative",
    )
    for index, raw in enumerate(cloud.get("evidence") or []):
        evidence = _mapping(raw, f"cloudDirect.evidence[{index}]")
        path = root / _safe_path(evidence.get("path"), "evidence.path")
        _require(path.is_file(), f"missing evidence: {path}")
        _require(_sha256(path) == evidence.get("sha256"), f"evidence hash mismatch: {path}")

    notes = _mapping(manifest.get("structuredNotes"), "structuredNotes")
    _require(notes.get("status") == "PASS", "structuredNotes must be PASS")
    _require(
        notes.get("outputSchema") == "meeting_intelligence_output/v1",
        "output schema mismatch",
    )
    _require(len(notes.get("templates") or []) == 7, "general plus six templates required")
    for field in (
        "evidenceRequiredForPublication",
        "titleSuggestionRequiresExplicitApply",
        "persistentRecovery",
    ):
        _require(notes.get(field) is True, f"structuredNotes.{field} must be true")

    speaker = _mapping(manifest.get("speakerAdmission"), "speakerAdmission")
    speaker_manifest_path = root / _safe_path(
        speaker.get("manifestPath"),
        "speakerAdmission.manifestPath",
    )
    speaker_contract_path = root / _safe_path(
        speaker.get("contractPath"),
        "speakerAdmission.contractPath",
    )
    _require(speaker_manifest_path.is_file(), "speaker manifest missing")
    _require(speaker_contract_path.is_file(), "speaker contract missing")
    _require(
        _sha256(speaker_manifest_path) == speaker.get("manifestSha256"),
        "speaker manifest evidence hash mismatch",
    )
    _require(
        _sha256(speaker_contract_path) == speaker.get("contractSha256"),
        "speaker contract hash mismatch",
    )
    speaker_validator = _load_module(
        "evaluate_speaker_diarization_for_s3",
        root / "benchmark/evaluate_speaker_diarization.py",
    )
    speaker_evidence = json.loads(speaker_manifest_path.read_text(encoding="utf-8"))
    speaker_contract = json.loads(speaker_contract_path.read_text(encoding="utf-8"))
    speaker_result = speaker_validator.validate_manifest(
        speaker_evidence,
        speaker_contract,
    )
    speaker_evidence_by_role = {}
    for raw in speaker_evidence.get("evidenceFiles") or []:
        evidence = _mapping(raw, "speaker evidence file")
        evidence_path = root / _safe_path(
            evidence.get("path"),
            "speaker evidence path",
        )
        _require(evidence_path.is_file(), f"speaker evidence missing: {evidence_path}")
        _require(
            _sha256(evidence_path) == evidence.get("sha256"),
            f"speaker evidence hash mismatch: {evidence_path}",
        )
        speaker_evidence_by_role[evidence["role"]] = json.loads(
            evidence_path.read_text(encoding="utf-8")
        )
    speaker_validator.validate_deferred_evidence_summary(
        speaker_evidence,
        speaker_evidence_by_role,
    )
    _require(
        speaker.get("status") == speaker_result["status"],
        "speaker status must match evidence manifest",
    )
    _require(
        speaker.get("productAvailable") is False,
        "speaker product must remain unavailable after admission",
    )
    for field in (
        "verified",
        "eligibleForProductization",
        "productAvailable",
    ):
        _require(
            speaker.get(field) == speaker_result[field],
            f"speaker {field} must match evidence manifest",
        )
    _require(
        speaker.get("failedGates") == speaker_result["failedGates"],
        "speaker failedGates must match evidence manifest",
    )
    _require(
        speaker.get("productEntrance") is False,
        "speaker product entrance must remain closed after admission",
    )
    _require(speaker.get("persistsVoiceprints") is False, "voiceprints are forbidden")

    paired = _mapping(manifest.get("pairedPc"), "pairedPc")
    schema_path = root / _safe_path(paired.get("schemaPath"), "pairedPc.schemaPath")
    _require(schema_path.is_file(), "paired-PC schema missing")
    _require(_sha256(schema_path) == paired.get("schemaSha256"), "paired-PC schema hash mismatch")
    _require(paired.get("processingLocation") == "pairedPc", "paired-PC location mismatch")
    if paired.get("status") == "PASS":
        _require(
            paired.get("runtimePresent") is True
            and paired.get("mobileAdapterPresent") is True
            and paired.get("productEntrance") is True,
            "paired-PC cannot pass without runtime, adapter, and product entrance",
        )
    else:
        _require(
            paired.get("status") == "DEFERRED_PC_RUNTIME_MISSING",
            "paired-PC status is invalid",
        )
        _require(paired.get("runtimePresent") is False, "PC runtime must remain absent")
        _require(paired.get("mobileAdapterPresent") is False, "PC adapter must remain absent")
        _require(paired.get("productEntrance") is False, "dead PC UI is forbidden")

    first = _mapping(manifest.get("firstIncrement"), "firstIncrement")
    expected_first = (
        "PASS"
        if cloud["status"] == notes["status"] == "PASS"
        and speaker.get("productAvailable") is True
        and paired.get("status") == "PASS"
        else "PARTIAL_PASS"
    )
    _require(
        first.get("status") == expected_first,
        f"derived first increment status must be {expected_first}",
    )

    multilingual = _mapping(manifest.get("multilingual"), "multilingual")
    full = _mapping(manifest.get("fullS3"), "fullS3")
    expected_full = (
        "PASS"
        if first["status"] == "PASS" and multilingual.get("status") == "PASS"
        else "BLOCKED"
    )
    _require(full.get("status") == expected_full, f"derived full S3 status must be {expected_full}")

    desktop = _mapping(
        manifest.get("desktopWorkstationTransition"),
        "desktopWorkstationTransition",
    )
    _require(
        desktop.get("decisionId")
        == "DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26",
        "desktop workstation transition decision mismatch",
    )
    _require(desktop.get("status") == "ACTIVE", "desktop workstation transition must be ACTIVE")
    _require(
        desktop.get("scopePath") == "docs/product/desktop-workstation-scope.json",
        "desktop workstation scope path mismatch",
    )
    _require(
        desktop.get("pairedPcProviderV1Role") == "STRUCTURED_NOTES_ONLY",
        "paired-PC provider v1 role must remain structured-notes-only",
    )

    asr005 = _mapping(manifest.get("asr005"), "asr005")
    _require(
        asr005.get("status") == "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
        "ASR-005 must be user-owned pre-release acceptance only",
    )
    _require(asr005.get("owner") == "user", "ASR-005 owner must be user")
    _require(asr005.get("developmentBlocker") is False, "ASR-005 cannot block development")
    _require(asr005.get("automatedReminder") is False, "ASR-005 cannot be an automated reminder")

    release = _mapping(manifest.get("releaseReadiness"), "releaseReadiness")
    _require(
        release.get("status") == "NOT_RELEASE_READY",
        "release must remain NOT_RELEASE_READY",
    )
    _require(
        "ASR-005-TIMESTAMP-INDEPENDENT" not in release.get("blockers", []),
        "ASR-005 cannot remain a development blocker",
    )
    _require("S3-FULL" in release.get("blockers", []), "full S3 blocker missing")

    _validate_no_dead_routes(
        root,
        speaker_product_closed=speaker["productEntrance"] is False,
    )
    if validate_documents:
        _validate_documents(manifest, root)

    return {
        "firstIncrement": first["status"],
        "speaker": speaker["status"],
        "pairedPc": paired["status"],
        "fullS3": full["status"],
        "releaseReadiness": release["status"],
    }


def _validate_no_dead_routes(root: Path, *, speaker_product_closed: bool) -> None:
    mobile_root = root / "apps/mobile-flutter"
    manifest_text = (mobile_root / "android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    _require("android.permission.CAMERA" not in manifest_text, "camera permission exists before PC runtime")
    forbidden_pc_files = [
        mobile_root / "lib/features/meeting_intelligence/service/paired_pc_meeting_intelligence_provider.dart",
        mobile_root / "lib/features/settings/pc_pairing_page.dart",
        mobile_root / "lib/features/settings/qr_pairing_page.dart",
    ]
    _require(not any(path.exists() for path in forbidden_pc_files), "PC pairing product route exists")
    if speaker_product_closed:
        forbidden_speaker_files = [
            mobile_root / "android/app/src/main/kotlin/com/voice2text/app/speakers/SpeakerDiarizationExecutor.kt",
            mobile_root / "lib/features/speakers/service/android_speaker_diarization_service.dart",
            mobile_root / "lib/features/speakers/widgets/speaker_review_panel.dart",
        ]
        _require(
            not any(path.exists() for path in forbidden_speaker_files),
            "speaker product entrance exists while gate is deferred",
        )


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
    for path, markers in actual.items():
        text = (root / path).read_text(encoding="utf-8")
        for marker in markers:
            _require(marker in text, f"{path} missing required marker: {marker}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", nargs="?", default=str(DEFAULT_MANIFEST))
    args = parser.parse_args()
    try:
        result = validate_scope_contract(Path(args.manifest), ROOT)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print("PASS: S3 productization truth contract is internally consistent")
    for key, value in result.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
