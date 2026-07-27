#!/usr/bin/env python3
"""Fail-closed validator for the macOS workstation closure evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from tool.macos_artifact_hash import semantic_dart_macho_sha256
except ModuleNotFoundError:
    from macos_artifact_hash import semantic_dart_macho_sha256

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVIDENCE = ROOT / "docs/product/desktop-workstation-u9-evidence.json"
DEFAULT_SCOPE = ROOT / "docs/product/desktop-workstation-scope.json"
EXPECTED_TARGET = {
    "operatingSystem": "macos",
    "operatingSystemVersion": "15.7.5",
    "architecture": "arm64",
    "cpuModel": "Apple M2",
    "logicalCpuCount": 8,
    "memoryBytes": 17179869184,
}
EXPECTED_UNITS = {"U4", "U5", "U6", "U7", "U8"}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _safe_repository_path(value: Any, label: str) -> Path:
    _require(isinstance(value, str) and value, f"{label} must be a path")
    relative = PurePosixPath(value)
    _require(
        not relative.is_absolute() and ".." not in relative.parts,
        f"{label} is unsafe",
    )
    path = ROOT.joinpath(*relative.parts)
    _require(path.is_file(), f"{label} is missing: {value}")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _load(path: Path, label: str) -> dict[str, Any]:
    _require(path.is_file(), f"{label} is missing")
    return _mapping(json.loads(path.read_text(encoding="utf-8")), label)


def validate_macos_closure(
    evidence_path: Path = DEFAULT_EVIDENCE,
    *,
    scope_path: Path = DEFAULT_SCOPE,
    validate_scope: bool = True,
) -> dict[str, Any]:
    if validate_scope:
        scope = _load(scope_path, "desktop scope")
        targets = _mapping(scope.get("targets"), "targets")
        macos = _mapping(targets.get("macos"), "macos")
        windows = _mapping(targets.get("windows"), "windows")
        if (
            macos.get("status") == "PRODUCT_IN_PROGRESS"
            and macos.get("closureStatus") == "NOT_RUN"
        ):
            frozen = _mapping(macos.get("frozenEngines"), "macOS frozen engines")
            _require(
                frozen.get("asr")
                == "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
                "Qwen3 revalidation has no frozen ASR",
            )
            _require(
                windows.get("status") == "BLOCKED_BY_MACOS_CLOSURE",
                "Windows must remain blocked during Qwen3 revalidation",
            )
            return {
                "target": "macos",
                "status": "PRODUCT_IN_PROGRESS",
                "disposition": "MACOS_QWEN3_REVALIDATION_REQUIRED",
            }

    evidence = _load(evidence_path, "U9 evidence")
    _require(evidence.get("schemaVersion") == 1, "U9 schema mismatch")
    _require(evidence.get("unit") == "U9", "U9 unit mismatch")
    _require(evidence.get("status") == "PASS", "U9 evidence is not PASS")
    _require(evidence.get("target") == "macos", "U9 evidence is not macOS")
    _require(
        evidence.get("targetFingerprint") == EXPECTED_TARGET,
        "target fingerprint mismatch",
    )

    bindings = evidence.get("evidenceBindings")
    _require(isinstance(bindings, list), "evidenceBindings must be an array")
    _require(
        {item.get("unit") for item in bindings if isinstance(item, dict)}
        == EXPECTED_UNITS,
        "missing required U4-U8 evidence",
    )
    bound: dict[str, dict[str, Any]] = {}
    for raw in bindings:
        item = _mapping(raw, "evidence binding")
        unit = item.get("unit")
        _require(isinstance(unit, str), "evidence unit is invalid")
        path = _safe_repository_path(item.get("path"), f"{unit} evidence")
        _require(_sha256(path) == item.get("sha256"), f"{unit} evidence hash drift")
        bound[unit] = _load(path, f"{unit} evidence")
        _require(bound[unit].get("unit") == unit, f"{unit} evidence content mismatch")
        if unit != "U8":
            _require(bound[unit].get("target") == "macos", f"{unit} is not target-specific")

    engine = _mapping(evidence.get("productEngine"), "productEngine")
    serialized_engine = json.dumps(engine, ensure_ascii=False).upper()
    _require("LAB_ONLY" not in serialized_engine, "LAB_ONLY engine entered product")
    _require(
        engine.get("asr") == "sherpa-streaming-zipformer-zh-14m-2023-02-23"
        and engine.get("diarization") == "sherpa-pyannote-3.0-3dspeaker"
        and engine.get("runtime") == "sherpa-onnx-c-api@1.13.4",
        "frozen product engine drift",
    )
    _require(
        engine.get("boundary") == "native_worker_process_group",
        "worker isolation boundary drift",
    )
    _require(engine.get("sidecarWinner") is None, "sidecar winner entered product")
    _require(engine.get("enginePickerVisible") is False, "engine picker entered product")
    product_entries = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for root in (
            ROOT / "apps/desktop/assets/processing",
            ROOT / "apps/desktop/lib/app",
        )
        for path in root.rglob("*")
        if path.is_file()
    ).upper()
    _require("LAB_ONLY" not in product_entries, "LAB_ONLY product entry found")

    u7_engine = _mapping(bound["U7"].get("productEngine"), "U7 productEngine")
    for field in (
        "diarizationClusteringThreshold",
        "workerThreads",
        "longMeetingShardThresholdSeconds",
        "longMeetingShardCount",
        "longMeetingShardOverlapSeconds",
        "manifestContentKey",
    ):
        _require(engine.get(field) == u7_engine.get(field), f"{field} evidence mismatch")
    artifacts = _mapping(engine.get("artifactHashes"), "artifactHashes")
    artifact_hash_schemes = _mapping(
        engine.get("artifactHashSchemes"),
        "artifactHashSchemes",
    )
    _require(len(artifacts) >= 6, "required product artifact hashes are missing")
    _require(
        set(artifact_hash_schemes)
        == {
            "apps/desktop/build/macos/Build/Products/Debug/"
            "voice2text_desktop.app/Contents/Resources/Processing/"
            "desktop_sherpa_worker"
        }
        and set(artifact_hash_schemes.values()) == {"dart_macho_semantic_v1"},
        "product artifact hash scheme drift",
    )
    for raw_path, expected_hash in artifacts.items():
        path = _safe_repository_path(raw_path, "product artifact")
        actual_hash = (
            semantic_dart_macho_sha256(path)
            if artifact_hash_schemes.get(raw_path) == "dart_macho_semantic_v1"
            else _sha256(path)
        )
        _require(actual_hash == expected_hash, f"artifact hash drift: {raw_path}")

    experience = _mapping(evidence.get("experienceGate"), "experienceGate")
    long_meeting = _mapping(experience.get("longMeeting"), "longMeeting")
    _require(long_meeting.get("status") == "PASS", "long meeting evidence missing")
    _require(
        long_meeting.get("fixtureSha256")
        == "6a4f0849cee47ad9daecac04d92977c8cf6b48de1dd43849ad60852de5b336c3",
        "long meeting fixture drift",
    )
    _require(
        long_meeting.get("durationMilliseconds") == 7_200_000
        and isinstance(long_meeting.get("elapsedMilliseconds"), int)
        and long_meeting["elapsedMilliseconds"] < 1_800_000
        and long_meeting.get("diarizationSucceeded") is True
        and isinstance(long_meeting.get("segmentCount"), int)
        and long_meeting["segmentCount"] > 0,
        "two-hour ASR + diarization experience gate failed",
    )
    dogfood = _mapping(experience.get("engineeringDogfood"), "engineeringDogfood")
    u7_dogfood = _mapping(bound["U7"].get("engineeringDogfood"), "U7 dogfood")
    _require(dogfood.get("status") == "PASS", "dogfood status is not PASS")
    for field in (
        "meetingCount",
        "speakerAssignmentsReviewed",
        "speakerCorrectionsRequired",
        "aggregateSpeakerCorrectionRate",
        "totalReviewAndFiveFormatExportMilliseconds",
        "recoveryStateUnderstanding",
        "continuedUseWillingness",
    ):
        _require(dogfood.get(field) == u7_dogfood.get(field), f"dogfood {field} drift")
    _require(
        dogfood.get("meetingCount", 0) >= 5
        and dogfood.get("speakerAssignmentsReviewed", 0) > 0
        and dogfood.get("aggregateSpeakerCorrectionRate", 1) <= 0.10
        and str(dogfood.get("recoveryStateUnderstanding", "")).startswith("PASS_")
        and str(dogfood.get("continuedUseWillingness", "")).startswith("PASS_"),
        "dogfood experience gate failed",
    )

    interaction = _mapping(
        evidence.get("interactionPerformance"),
        "interactionPerformance",
    )
    _require(
        interaction.get("segmentCount", 0) >= 3000
        and interaction.get("workspaceOpenP95Microseconds", 2_000_000)
        < interaction.get("workspaceOpenThresholdMicroseconds", 0)
        and interaction.get("searchP95Microseconds", 200_000)
        < interaction.get("searchThresholdMicroseconds", 0)
        and interaction.get("playbackSeekP95Microseconds", 200_000)
        < interaction.get("playbackSeekThresholdMicroseconds", 0)
        and interaction.get("fixedScrollFrameCount", 0) > 0
        and interaction.get("fixedScrollLongFrameRate", 1)
        < interaction.get("fixedScrollLongFrameRateThreshold", 0),
        "interaction performance gate failed",
    )

    lifecycle = _mapping(evidence.get("dataLifecycle"), "dataLifecycle")
    _require(
        lifecycle.get("status") == "PASS"
        and lifecycle.get("importStagingRetentionHours") == 24
        and lifecycle.get("sidecarWorkspaceRetentionHours") == 24
        and lifecycle.get("ephemeralShareRetentionHours") == 24
        and lifecycle.get("interruptedLanCheckpointRetentionDays") == 7
        and all(
            lifecycle.get(field) is True
            for field in (
                "receiptDeletesTransferPayloadImmediately",
                "unpairDeletesCredentialCheckpointAndReceiptMetadata",
                "committedMeetingSurvivesUnpair",
                "cleanupDoesNotFollowSymlinks",
                "runtimePruneUninstallAndReplacementCovered",
            )
        ),
        "data lifecycle gate failed",
    )
    security = _mapping(evidence.get("securityAndPrivacy"), "securityAndPrivacy")
    _require(
        security.get("status") == "PASS"
        and security.get("fileVaultAtCapture") in {"ON", "OFF", "UNKNOWN"}
        and security.get("truthfulNoAppLayerDatabaseOrAudioEncryptionDisclosure")
        is True
        and security.get("fileVaultDisabledPromptCovered") is True
        and security.get("apiAndPairingSecretsUseMacosKeychain") is True
        and security.get("workerInheritsParentEnvironment") is False
        and security.get("plaintextOrCredentialCaptureDetected") is False,
        "security/privacy gate failed",
    )
    accessibility = _mapping(
        evidence.get("accessibilityAndRegression"),
        "accessibilityAndRegression",
    )
    _require(
        accessibility.get("status") == "PASS"
        and accessibility.get("realMacosIntegrationTestsPassed", 0) >= 3
        and all(
            accessibility.get(field) is True
            for field in (
                "keyboardNavigation",
                "semanticNavigationLabel",
                "darkMode",
                "textScale200Percent",
                "longTranscriptVirtualized",
                "nonDragPlaybackAndSeekActions",
            )
        ),
        "accessibility/regression gate failed",
    )

    lan = _mapping(evidence.get("lanHandoff"), "lanHandoff")
    _require(
        lan.get("status") == "PASS_MACOS_ANDROID_LAN",
        "LAN handoff remains unverified",
    )
    lan_path = _safe_repository_path(lan.get("evidencePath"), "LAN evidence")
    _require(_sha256(lan_path) == lan.get("evidenceSha256"), "LAN artifact hash drift")
    _require(
        bound["U8"].get("status") == "PASS_MACOS_ANDROID_LAN",
        "U8 physical LAN evidence is not PASS",
    )

    verification = _mapping(evidence.get("verification"), "verification")
    _require(
        verification
        == {
            "desktopStaticAnalysis": "PASS",
            "desktopFlutterTests": "PASS",
            "rootFlutterTests": "PASS",
            "macosIntegrationTests": "PASS",
            "privacyContract": "PASS",
            "macosDebugBuild": "PASS",
            "devCheckWithBuild": "PASS",
        },
        "verification contract is incomplete",
    )
    _require(
        evidence.get("disposition") == "MACOS_CLOSED_FOR_WINDOWS_ENTRY",
        "closure disposition mismatch",
    )

    if validate_scope:
        scope = _load(scope_path, "desktop scope")
        targets = _mapping(scope.get("targets"), "targets")
        macos = _mapping(targets.get("macos"), "macos")
        windows = _mapping(targets.get("windows"), "windows")
        _require(
            macos.get("status") == "PASS" and macos.get("closureStatus") == "PASS",
            "scope macOS closure is not PASS",
        )
        _require(windows.get("status") == "PLANNED", "Windows was not opened after macOS")
        expected_evidence_hash = _sha256(evidence_path)
        _require(
            any(
                item.get("path")
                == "docs/product/desktop-workstation-u9-evidence.json"
                and item.get("sha256") == expected_evidence_hash
                for item in macos.get("evidence", [])
                if isinstance(item, dict)
            ),
            "scope U9 evidence hash mismatch",
        )
        _require(
            _mapping(scope.get("lanHandoff"), "scope LAN").get("status")
            == "PASS_MACOS_ANDROID_LAN",
            "scope LAN status regressed",
        )

    return {
        "target": "macos",
        "elapsedMilliseconds": long_meeting["elapsedMilliseconds"],
        "dogfoodCorrectionRate": dogfood["aggregateSpeakerCorrectionRate"],
        "disposition": "MACOS_CLOSED_FOR_WINDOWS_ENTRY",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--scope", type=Path, default=DEFAULT_SCOPE)
    parser.add_argument("--skip-scope", action="store_true")
    args = parser.parse_args()
    try:
        result = validate_macos_closure(
            args.evidence,
            scope_path=args.scope,
            validate_scope=not args.skip_scope,
        )
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
