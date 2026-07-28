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
        "PRODUCT_IN_PROGRESS",
        "BLOCKED_BY_MACOS_CLOSURE",
        "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
        "DEVELOPMENT_ONLY",
        "RELEASE_SCOPE_PAUSED",
    },
    "docs/product/mobile-capability-matrix.md": {
        DECISION_ID,
        "桌面主工作站",
        "PRODUCT_IN_PROGRESS",
        "BLOCKED_BY_MACOS_CLOSURE",
        "USER_PRE_RELEASE_ACCEPTANCE_ONLY",
        "DEVELOPMENT_ONLY",
        "RELEASE_SCOPE_PAUSED",
    },
    "docs/product/s3-productization-status.md": {
        DECISION_ID,
        "桌面主工作站",
        "BLOCKED_BY_MACOS_CLOSURE",
    },
    "docs/product/desktop-workstation-status.md": {
        DECISION_ID,
        "PRODUCT_IN_PROGRESS",
        "BLOCKED_BY_MACOS_CLOSURE",
        "TARGET_SPECIFIC",
        "DEVELOPMENT_ONLY",
        "BLOCKED_BY_EXPANDED_MACOS_CLOSURE",
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
EXPANDED_CAPABILITY_STATUSES = {
    "PLANNED",
    "CONTRACT_FROZEN",
    "IMPLEMENTATION_IN_PROGRESS",
    "U13_CONTROL_PASS_PENDING_U18_PROFILE",
    "U18_CONTROL_RETAINED_PASS",
    "PASS",
    "UNAVAILABLE",
}
EXPECTED_MACOS_DEVELOPMENT_TARGET = {
    "modelIdentifier": "Mac16,10",
    "os": "macOS 15.7.5",
    "osBuild": "24G624",
    "architecture": "arm64",
    "cpu": "Apple M4",
    "logicalCpuCount": 10,
    "memoryBytes": 17179869184,
    "buildMode": "debug",
}
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


def _validate_u12_capture_evidence(evidence: dict[str, Any]) -> None:
    _require(
        evidence.get("schemaVersion") == 1
        and evidence.get("status") == "PASS",
        "U12 capture evidence is not PASS",
    )
    _require(
        evidence.get("target") == EXPECTED_MACOS_DEVELOPMENT_TARGET,
        "U12 capture evidence target drifted",
    )
    integration_build = _mapping(
        evidence.get("integrationBuild"),
        "U12 integration build",
    )
    crash_build = _mapping(
        evidence.get("crashProbeBuild"),
        "U12 crash probe build",
    )
    for label, build in (
        ("integration", integration_build),
        ("crash probe", crash_build),
    ):
        _require(
            build.get("bundleIdentifier") == "com.voice2text.voice2textDesktop"
            and build.get("signature") == "adhoc"
            and build.get("teamIdentifier") is None
            and isinstance(build.get("cdHash"), str)
            and len(build["cdHash"]) == 40
            and isinstance(build.get("executableSha256"), str)
            and SHA256_PATTERN.fullmatch(build["executableSha256"]) is not None,
            f"U12 {label} build binding is invalid",
        )
    database = _mapping(evidence.get("database"), "U12 database evidence")
    _require(
        database.get("schemaVersion") == 22
        and database.get("minimumIndependentAuthorityAssetCount", 0) >= 6
        and database.get("manifestAndChunkCommitAtomic") is True
        and database.get("persistentCommandReceiptsIdempotent") is True,
        "U12 database durability evidence is incomplete",
    )
    termination = _mapping(
        evidence.get("actualProcessTermination"),
        "U12 actual process termination",
    )
    stages = termination.get("stages")
    _require(
        termination.get("secondRecoveryIsIdempotent") is True
        and isinstance(termination.get("maximumFirstRecoveryMs"), int)
        and termination["maximumFirstRecoveryMs"] <= 30_000
        and termination.get("invalidFinalizedChunks") == 0
        and isinstance(stages, list)
        and len(stages) == 3,
        "U12 actual process termination evidence is incomplete",
    )
    expected_exit_codes = {
        "during_write": 86,
        "during_finalize": 87,
        "after_journal": 88,
    }
    observed: set[str] = set()
    for raw_stage in stages:
        stage = _mapping(raw_stage, "U12 crash stage")
        name = stage.get("stage")
        _require(
            name in expected_exit_codes
            and name not in observed
            and stage.get("status") == "PASS"
            and stage.get("expectedExitCode") == expected_exit_codes[name]
            and stage.get("observedExitCode") == expected_exit_codes[name]
            and isinstance(stage.get("quarantinedTailChunks"), int)
            and 0 <= stage["quarantinedTailChunks"] <= 2
            and isinstance(stage.get("recoveryEvidenceSha256"), str)
            and SHA256_PATTERN.fullmatch(stage["recoveryEvidenceSha256"]) is not None,
            "U12 crash stage binding is invalid",
        )
        observed.add(name)
    _require(
        observed == set(expected_exit_codes),
        "U12 crash stage coverage is incomplete",
    )
    decision = _mapping(evidence.get("decision"), "U12 decision")
    _require(
        decision.get("u12ImplementationGatePassed") is True
        and decision.get("mobileImplementationChanged") is False
        and decision.get("probeDurationBelowThirtyMinutes") is True,
        "U12 implementation decision failed",
    )


def _validate_u13_live_caption_evidence(
    summary: dict[str, Any],
    decision: dict[str, Any],
) -> None:
    _require(
        summary.get("schemaVersion") == 1
        and summary.get("status") == "COMPLETE"
        and summary.get("target") == EXPECTED_MACOS_DEVELOPMENT_TARGET,
        "U13 live-caption summary is not target-bound COMPLETE evidence",
    )
    bindings = _mapping(summary.get("bindings"), "U13 summary bindings")
    _require(
        all(
            isinstance(bindings.get(field), str)
            and SHA256_PATTERN.fullmatch(bindings[field]) is not None
            for field in (
                "fixtureManifestSha256",
                "scorerSha256",
                "modelArchiveSha256",
                "sileroVadSha256",
                "rawSha256",
                "flutterCaptureProbeSha256",
            )
        ),
        "U13 live-caption summary bindings are incomplete",
    )
    latency = _mapping(summary.get("latency"), "U13 latency")
    resources = _mapping(summary.get("resources"), "U13 resources")
    stability = _mapping(summary.get("stability"), "U13 stability")
    _require(
        isinstance(latency.get("speechEndToVisibleP50Ms"), (int, float))
        and latency["speechEndToVisibleP50Ms"] <= 1000
        and isinstance(latency.get("speechEndToVisibleP95Ms"), (int, float))
        and latency["speechEndToVisibleP95Ms"] <= 2000
        and isinstance(latency.get("maximumBacklogSeconds"), (int, float))
        and latency["maximumBacklogSeconds"] <= 10
        and latency.get("measurement")
        == "flutter_frame_timing_composed_with_worker_receipt"
        and summary.get("captureFrameLossDelta") == 0,
        "U13 live-caption latency or capture gates failed",
    )
    _require(
        isinstance(resources.get("maximumAppRssBytes"), int)
        and resources["maximumAppRssBytes"] <= 1610612736
        and resources.get("uiLongFrameRate") == 0
        and stability.get("durationSeconds") == 900.0
        and stability.get("maximumUtteranceSeconds") <= 15
        and stability.get("crashed") is False
        and stability.get("oom") is False,
        "U13 live-caption resource or stability gates failed",
    )
    _require(
        decision.get("schemaVersion") == 1
        and decision.get("status") == "PASS"
        and decision.get("target") == EXPECTED_MACOS_DEVELOPMENT_TARGET
        and decision.get("productDisposition")
        == "U13_CONTROL_ADMITTED_PENDING_U18_OPTIMIZATION_DECISION",
        "U13 live-caption machine decision is invalid",
    )


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


def _validate_qwen3_product_decision(
    decision: dict[str, Any],
    frozen: dict[str, Any],
) -> None:
    product = _mapping(decision.get("product"), "Qwen3 product decision")
    profile = _mapping(product.get("profile"), "Qwen3 product profile")
    _require(
        product.get("asrCandidateId") == frozen["asr"]
        and product.get("asrCandidateCount") == 1
        and product.get("diarizationIsIndependent") is True
        and product.get("runtimeLaneId")
        == "sherpa-onnx-dart-1.13.4-ort-1.27.0-macos-arm64"
        and profile
        == {
            "provider": "cpu",
            "numThreads": 2,
            "concurrency": 1,
            "modelPrecision": "int8",
            "segmentDurationSeconds": 15,
            "maxTotalLen": 512,
            "maxNewTokens": 512,
            "temperature": 0.000001,
            "topP": 0.8,
            "seed": 42,
            "hotwords": "",
            "segmentation": "official_silero_vad",
            "vadThreshold": 0.2,
            "minimumSpeechSeconds": 0.2,
            "maximumSpeechSeconds": 12,
        },
        "macOS frozen engines disagree with machine decision",
    )


def _validate_expanded_desktop_capabilities(
    manifest: dict[str, Any],
    root: Path,
) -> None:
    targets = _mapping(manifest.get("targets"), "targets")
    macos = _mapping(targets.get("macos"), "targets.macos")
    _require(
        macos.get("developmentReferenceTarget")
        == EXPECTED_MACOS_DEVELOPMENT_TARGET,
        "macOS development reference target drifted",
    )
    expanded = _mapping(
        manifest.get("expandedDesktopCapabilities"),
        "expandedDesktopCapabilities",
    )
    _require(expanded.get("contractVersion") == 1, "expanded contract version changed")
    _require(expanded.get("developmentOnly") is True, "desktop must stay DEVELOPMENT_ONLY")
    _require(
        expanded.get("mobileImplementationRequired") is False
        and expanded.get("mobileUiChangesAllowed") is False,
        "desktop expansion cannot require mobile implementation or UI",
    )
    _require(
        expanded.get("maximumProbeMinutes") == 30,
        "expanded desktop probes must be bounded to 30 minutes",
    )
    expected_windows_status = "BLOCKED_BY_EXPANDED_MACOS_CLOSURE"
    for name in ("capture", "liveCaption", "openAiProviders"):
        capability = _mapping(expanded.get(name), f"expandedDesktopCapabilities.{name}")
        _require(
            capability.get("status") in EXPANDED_CAPABILITY_STATUSES,
            f"{name} expanded capability status is invalid",
        )
        _require(
            capability.get("windowsStatus") == expected_windows_status,
            f"{name} cannot unlock Windows before expanded macOS closure",
        )

    capture = _mapping(expanded.get("capture"), "expandedDesktopCapabilities.capture")
    _require(capture.get("capturesScreenPixels") is False, "capture cannot record screen pixels")
    _require(
        capture.get("applicationMinimumMacosVersion") == "13.0"
        and capture.get("microphoneOnlyCaptureMinimumMacosVersion") == "13.0"
        and capture.get("coreAudioTapApiMinimumMacosVersion") == "14.2"
        and capture.get("localProcessingMinimumMacosVersion") == "15.5",
        "capture minimum macOS contract changed",
    )
    _require(
        capture.get("captureModes") == ["microphone_only", "dual_track"]
        and capture.get("lowerVersionBehavior")
        == "MICROPHONE_ONLY_WITH_EXPLICIT_WARNING",
        "capture lower-version behavior changed",
    )
    for field in ("contractPath", "architecturePath", "evidencePath"):
        relative = _safe_path(capture.get(field), f"capture.{field}")
        _require((root / relative).is_file(), f"capture.{field} is missing")
    evidence = json.loads(
        (root / capture["evidencePath"]).read_text(encoding="utf-8")
    )
    _require(
        evidence.get("target")
        == {
            key: EXPECTED_MACOS_DEVELOPMENT_TARGET[key]
            for key in (
                "os",
                "osBuild",
                "architecture",
                "cpu",
                "logicalCpuCount",
                "memoryBytes",
                "buildMode",
            )
        },
        "capture evidence target does not match the macOS development reference target",
    )
    decision = _mapping(evidence.get("decision"), "capture evidence decision")
    if capture.get("status") in {"CONTRACT_FROZEN", "PASS"}:
        _require(
            evidence.get("status") == "PASS"
            and decision.get("captureContractFrozen") is True
            and decision.get("u12Allowed") is True,
            "completed capture capability lacks current physical evidence",
        )
        observations = evidence.get("observations")
        _require(
            isinstance(observations, list) and len(observations) == 1,
            "completed capture capability requires one physical observation",
        )
        observation = _mapping(observations[0], "capture observation")
        observation_path = root / _safe_path(
            observation.get("path"),
            "capture observation.path",
        )
        observation_digest = observation.get("sha256")
        _require(
            isinstance(observation_digest, str)
            and SHA256_PATTERN.fullmatch(observation_digest) is not None
            and observation_path.is_file(),
            "capture observation binding is invalid",
        )
        observation_bytes = observation_path.read_bytes()
        _require(
            hashlib.sha256(observation_bytes).hexdigest() == observation_digest,
            "capture observation hash mismatch",
        )
        physical = json.loads(observation_bytes)
        physical_target = _mapping(physical.get("target"), "capture physical target")
        physical_probe = _mapping(physical.get("probe"), "capture physical probe")
        recovery = _mapping(physical.get("recovery"), "capture recovery")
        physical_decision = _mapping(
            physical.get("decision"),
            "capture physical decision",
        )
        faults = recovery.get("faultInjection")
        _require(
            physical.get("status") == "PASS"
            and physical.get("admissibleForDeclaredClosureTarget") is True
            and physical_target
            == EXPECTED_MACOS_DEVELOPMENT_TARGET
            and physical_probe.get("requestedDurationSeconds") == 1200
            and observation.get("durationSeconds") == 1200
            and recovery.get("invalidFinalizedChunks") == 0
            and isinstance(recovery.get("maximumRecoveryMs"), int)
            and recovery["maximumRecoveryMs"] <= 30_000
            and recovery.get("maximumTailChunksQuarantinedPerTrack") == 1
            and physical_decision.get("chunksValid") is True
            and physical_decision.get("recoveryValid") is True
            and physical_decision.get("captureContractFrozen") is True
            and physical_decision.get("u12Allowed") is True,
            "capture physical evidence failed frozen gates",
        )
        _require(
            isinstance(faults, list)
            and {
                fault.get("stage")
                for fault in faults
                if isinstance(fault, dict)
                and fault.get("status") == "PASS"
                and fault.get("idempotent") is True
            }
            == {"during_write", "during_finalize", "after_journal"},
            "capture physical fault evidence is incomplete",
        )
        if capture.get("status") == "PASS":
            u12_binding = _mapping(evidence.get("u12Evidence"), "capture U12 evidence")
            u12_path = root / _safe_path(
                u12_binding.get("path"),
                "capture.u12Evidence.path",
            )
            u12_digest = u12_binding.get("sha256")
            _require(
                u12_binding.get("status") == "PASS"
                and isinstance(u12_digest, str)
                and SHA256_PATTERN.fullmatch(u12_digest) is not None
                and u12_path.is_file(),
                "capture PASS lacks U12 evidence",
            )
            u12_bytes = u12_path.read_bytes()
            _require(
                hashlib.sha256(u12_bytes).hexdigest() == u12_digest,
                "capture U12 evidence hash mismatch",
            )
            _validate_u12_capture_evidence(json.loads(u12_bytes))
            _require(
                decision.get("u12ImplementationGatePassed") is True,
                "capture PASS lacks U12 implementation decision",
            )

    live_caption = _mapping(
        expanded.get("liveCaption"),
        "expandedDesktopCapabilities.liveCaption",
    )
    _require(
        live_caption.get("mode") == "VAD_SIMULATED_STREAMING"
        and live_caption.get("authority") == "sensevoice_live_draft",
        "live caption cannot claim token streaming or formal authority",
    )
    if live_caption.get("status") in {
        "U13_CONTROL_PASS_PENDING_U18_PROFILE",
        "U18_CONTROL_RETAINED_PASS",
    }:
        evidence_path = root / _safe_path(
            live_caption.get("evidencePath"),
            "liveCaption.evidencePath",
        )
        decision_path = root / _safe_path(
            live_caption.get("decisionPath"),
            "liveCaption.decisionPath",
        )
        evidence_digest = live_caption.get("evidenceSha256")
        decision_digest = live_caption.get("decisionSha256")
        _require(
            evidence_path.is_file()
            and decision_path.is_file()
            and isinstance(evidence_digest, str)
            and SHA256_PATTERN.fullmatch(evidence_digest) is not None
            and isinstance(decision_digest, str)
            and SHA256_PATTERN.fullmatch(decision_digest) is not None,
            "U13 live-caption evidence binding is invalid",
        )
        evidence_bytes = evidence_path.read_bytes()
        decision_bytes = decision_path.read_bytes()
        _require(
            hashlib.sha256(evidence_bytes).hexdigest() == evidence_digest
            and hashlib.sha256(decision_bytes).hexdigest() == decision_digest,
            "U13 live-caption evidence hash mismatch",
        )
        summary = json.loads(evidence_bytes)
        live_decision = json.loads(decision_bytes)
        if live_caption["status"] == "U13_CONTROL_PASS_PENDING_U18_PROFILE":
            decision_summary = _mapping(
                _mapping(
                    live_decision.get("bindings"),
                    "U13 decision bindings",
                ).get("summary"),
                "U13 decision summary binding",
            )
            _require(
                decision_summary.get("path") == live_caption["evidencePath"]
                and decision_summary.get("sha256") == evidence_digest,
                "U13 decision does not bind the evaluated summary",
            )
            _validate_u13_live_caption_evidence(summary, live_decision)
        else:
            u18_decision = _mapping(
                live_decision.get("decision"),
                "U18 decision",
            )
            selected = _mapping(
                live_decision.get("selectedProfile"),
                "U18 selected profile",
            )
            u18_bindings = _mapping(
                live_decision.get("bindings"),
                "U18 bindings",
            )
            _require(
                live_decision.get("schemaVersion") == 1
                and live_decision.get("status") == "PASS"
                and live_decision.get("target")
                == EXPECTED_MACOS_DEVELOPMENT_TARGET
                and u18_decision.get("status") == "CONTROL_RETAINED"
                and u18_decision.get("selectedArm") == "control"
                and selected.get("id") == "control"
                and live_caption.get("selectedProfile") == "control"
                and live_caption.get("screenedCandidate")
                == u18_decision.get("screenedCandidate"),
                "U18 control-retained decision is invalid",
            )
            for binding_name in (
                "screeningRaw",
                "screeningSummary",
                "finalistRaw",
                "finalistSummary",
                "u13Raw",
                "u13Decision",
                "u13IntegrationProbe",
            ):
                binding = _mapping(
                    u18_bindings.get(binding_name),
                    f"U18 {binding_name} binding",
                )
                binding_path = root / _safe_path(
                    binding.get("path"),
                    f"U18 {binding_name}.path",
                )
                binding_sha = binding.get("sha256")
                _require(
                    binding_path.is_file()
                    and isinstance(binding_sha, str)
                    and SHA256_PATTERN.fullmatch(binding_sha) is not None
                    and hashlib.sha256(binding_path.read_bytes()).hexdigest()
                    == binding_sha,
                    f"U18 {binding_name} binding is invalid",
                )
            u13_decision_binding = _mapping(
                u18_bindings["u13Decision"],
                "U18 U13 decision binding",
            )
            u13_decision = json.loads(
                (
                    root
                    / _safe_path(
                        u13_decision_binding["path"],
                        "U18 u13Decision.path",
                    )
                ).read_text(encoding="utf-8")
            )
            u13_summary_binding = _mapping(
                _mapping(
                    u13_decision.get("bindings"),
                    "U13 decision bindings",
                ).get("summary"),
                "U13 decision summary binding",
            )
            _require(
                u13_summary_binding.get("path")
                == live_caption["evidencePath"]
                and u13_summary_binding.get("sha256") == evidence_digest,
                "U18 retained control does not bind the U13 summary",
            )
            _validate_u13_live_caption_evidence(summary, u13_decision)
    providers = _mapping(
        expanded.get("openAiProviders"),
        "expandedDesktopCapabilities.openAiProviders",
    )
    _require(
        providers.get("providers")
        == ["deepseek", "openai_compatible"]
        and providers.get("localGenerativeModelRequired") is False
        and providers.get("customEndpointPolicy") == "REMOTE_HTTPS_ONLY"
        and providers.get("remoteConsent") == "PER_MEETING"
        and providers.get("automaticFallback") is False,
        "open AI provider security contract changed",
    )


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
                "asr": "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
                "diarization": "sherpa-pyannote-3.0-3dspeaker",
                "runtime": "sherpa-onnx-c-api@1.13.4",
                "boundary": "native_worker_process_group",
                "machineDecision": (
                    "benchmark/desktop/asr_comparison/"
                    "pc_qwen3_optimization_baseline.json"
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
        )
        _validate_qwen3_product_decision(decision, frozen)

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
    _validate_expanded_desktop_capabilities(manifest, root)

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
