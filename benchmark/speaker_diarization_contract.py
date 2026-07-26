"""Validate the persistent S3 speaker-admission contract and result manifest."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

PASS_STATUS = "VERIFIED"
DEFERRED_STATUSES = {
    "DEFERRED_MODEL_AND_FIXTURE_GATE",
    "DEFERRED_LICENSE_GATE",
    "DEFERRED_FUNCTIONAL_GATE",
    "DEFERRED_RESOURCE_GATE",
    "DEFERRED_NO_ADMISSIBLE_CANDIDATE",
}
ALLOWED_FAILED_GATES = {
    "MODEL_AND_FIXTURE",
    "LICENSE",
    "FUNCTIONAL",
    "RESOURCE",
    "NO_ADMISSIBLE_CANDIDATE",
}
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "benchmark/speaker_diarization_admission_contract.json"
DEFAULT_FINAL_DIAGNOSTIC_CONTRACT = (
    ROOT / "benchmark/speaker_diarization_final_diagnostic_contract.json"
)


class ManifestError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ManifestError(message)


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdefABCDEF" for char in value)
    )


def _require_final_diagnostic_model(model: Any, label: str) -> dict[str, Any]:
    require(isinstance(model, dict), f"{label} identity missing")
    require(bool(model.get("id")), f"{label} id missing")
    require(is_sha256(model.get("sha256")), f"{label} SHA-256 missing")
    require(
        isinstance(model.get("bytes"), int) and model["bytes"] > 0,
        f"{label} bytes missing",
    )
    require(bool(model.get("license")), f"{label} license missing")
    require(model.get("licenseReviewed") is True, f"{label} license not reviewed")
    return model


def _require_official_parity_arm(arm: Any, label: str) -> dict[str, Any]:
    require(isinstance(arm, dict), f"{label} must be an object")
    require(arm.get("mode") == "OFFICIAL_PARITY", f"{label} must be official parity")
    require(
        isinstance(arm.get("numThreads"), int) and arm["numThreads"] > 0,
        f"{label} numThreads invalid",
    )
    require(
        arm.get("directFullFixtureProcess") is True
        and arm.get("usesWindowing") is False
        and arm.get("usesExternalEmbedding") is False
        and arm.get("usesReconciliation") is False,
        f"{label} official parity must call process on the full fixture without "
        "windowing, external embedding, or reconciliation",
    )
    _require_final_diagnostic_model(arm.get("segmentation"), f"{label} segmentation")
    _require_final_diagnostic_model(arm.get("embedding"), f"{label} embedding")
    clustering = arm.get("clustering")
    require(isinstance(clustering, dict), f"{label} clustering identity missing")
    require(
        clustering
        == {
            "algorithm": "fast_clustering",
            "numSpeakers": 2,
            "threshold": 0.5,
        },
        f"{label} official parity clustering changed",
    )
    require(arm.get("minDurationOn") == 0.3, f"{label} minDurationOn changed")
    require(arm.get("minDurationOff") == 0.5, f"{label} minDurationOff changed")
    return arm


def validate_final_diagnostic_contract(
    contract: dict[str, Any],
    *,
    require_terminal: bool = True,
) -> None:
    """Validate the single-run mobile diarization closure experiment."""
    require(contract.get("schemaVersion") == 1, "final diagnostic schemaVersion must be 1")
    require(
        contract.get("contractId") == "speaker-diarization-final-diagnostic/v1",
        "final diagnostic contractId mismatch",
    )
    target = contract.get("target")
    require(isinstance(target, dict), "final diagnostic target missing")
    require(
        target.get("platform") == "android"
        and target.get("manufacturer") == "Xiaomi"
        and target.get("model") == "M2102J2SC"
        and isinstance(target.get("minimumSdkInt"), int),
        "final diagnostic target mismatch",
    )
    fixture = contract.get("fixture")
    require(isinstance(fixture, dict), "final diagnostic fixture missing")
    require(is_sha256(fixture.get("wavSha256")), "final diagnostic WAV hash missing")
    require(is_sha256(fixture.get("rttmSha256")), "final diagnostic RTTM hash missing")
    require(fixture.get("sampleRate") == 16_000, "final diagnostic sample rate changed")
    require(fixture.get("durationSeconds") == 300, "final diagnostic duration changed")
    thresholds = contract.get("thresholds")
    require(isinstance(thresholds, dict), "final diagnostic thresholds missing")
    for field in (
        "minimumAnnotatedSpeechCoverage",
        "maximumDer",
        "maximumRtf",
    ):
        require(
            isinstance(thresholds.get(field), (int, float)),
            f"final diagnostic {field} missing",
        )
    for field in (
        "requiresOverlapRepresentation",
        "requiresNoSpeakerInPreregisteredSilence",
        "requiresTranscriptSnapshotHashMatch",
        "requiresCompleteInputConsumption",
    ):
        require(thresholds.get(field) is True, f"final diagnostic {field} must be true")

    control = contract.get("controlArm")
    require(isinstance(control, dict), "product-integration control arm missing")
    require(
        control.get("id") == "product-integration-control"
        and control.get("frozenWindowSamples") == 480_000
        and control.get("frozenOverlapSamples") == 80_000
        and control.get("frozenReconciliationThreshold") == 0.8,
        "product-integration control arm drifted",
    )

    raw_arms = contract.get("parityArms")
    require(isinstance(raw_arms, list) and len(raw_arms) == 4, "four parity arms required")
    arms = {
        arm.get("id"): _require_official_parity_arm(arm, f"parityArms[{index}]")
        for index, arm in enumerate(raw_arms)
        if isinstance(arm, dict)
    }
    expected_ids = {
        "official-3dspeaker-t1",
        "official-3dspeaker-t2",
        "official-3dspeaker-t4",
        "official-titanet-t2",
    }
    require(set(arms) == expected_ids, "final diagnostic parity arm set changed")
    require(
        [arms[f"official-3dspeaker-t{threads}"]["numThreads"] for threads in (1, 2, 4)]
        == [1, 2, 4],
        "thread matrix must change only numThreads",
    )
    base = arms["official-3dspeaker-t2"]
    for arm_id in ("official-3dspeaker-t1", "official-3dspeaker-t4"):
        candidate = dict(arms[arm_id])
        baseline = dict(base)
        candidate.pop("id", None)
        candidate.pop("numThreads", None)
        candidate.pop("status", None)
        candidate.pop("evidencePath", None)
        candidate.pop("evidenceSha256", None)
        candidate.pop("evaluationPath", None)
        candidate.pop("evaluationSha256", None)
        baseline.pop("id", None)
        baseline.pop("numThreads", None)
        baseline.pop("status", None)
        baseline.pop("evidencePath", None)
        baseline.pop("evidenceSha256", None)
        baseline.pop("evaluationPath", None)
        baseline.pop("evaluationSha256", None)
        require(candidate == baseline, "thread matrix changes more than numThreads")
    titanet = arms["official-titanet-t2"]
    require(titanet["numThreads"] == 2, "TitaNet comparison must use two threads")
    require(
        titanet["segmentation"] == base["segmentation"]
        and titanet["clustering"] == base["clustering"]
        and titanet["minDurationOn"] == base["minDurationOn"]
        and titanet["minDurationOff"] == base["minDurationOff"],
        "TitaNet arm must change only embedding identity",
    )
    require(
        "titanet" in str(titanet["embedding"]["id"]).lower()
        and titanet["embedding"] != base["embedding"],
        "TitaNet embedding identity missing",
    )

    allowed_arm_statuses = {"PASS", "FAIL"} if require_terminal else {
        "PENDING",
        "IN_PROGRESS",
        "PASS",
        "FAIL",
    }
    for arm_id, arm in arms.items():
        require(arm.get("status") in allowed_arm_statuses, f"{arm_id} status is not terminal")
        if arm.get("status") in {"PASS", "FAIL"}:
            require(bool(arm.get("evidencePath")), f"{arm_id} evidence path missing")
            require(is_sha256(arm.get("evidenceSha256")), f"{arm_id} evidence hash missing")
            require(bool(arm.get("evaluationPath")), f"{arm_id} evaluation path missing")
            require(
                is_sha256(arm.get("evaluationSha256")),
                f"{arm_id} evaluation hash missing",
            )
    allowed_dispositions = {
        "MOBILE_DIARIZATION_ADMISSIBLE",
        "MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE",
    }
    if require_terminal:
        require(
            contract.get("terminalDisposition") in allowed_dispositions,
            "final diagnostic terminal disposition missing",
        )
        require(contract.get("nextCandidate") is None, "terminal diagnostic cannot name a next candidate")
    else:
        require(
            contract.get("terminalDisposition")
            in allowed_dispositions | {"PENDING_FINAL_DIAGNOSTIC"},
            "final diagnostic disposition invalid",
        )


def validate_final_diagnostic_evidence(
    evidence: dict[str, Any],
    arm: dict[str, Any],
    contract: dict[str, Any],
) -> None:
    """Validate one physical official-parity evidence record."""
    require(evidence.get("schemaVersion") == 1, "final evidence schemaVersion must be 1")
    require(
        evidence.get("source") == "physical_android_instrumentation",
        "final evidence must come from physical Android instrumentation",
    )
    require(evidence.get("contractId") == contract.get("contractId"), "contractId mismatch")
    require(evidence.get("armId") == arm.get("id"), "armId mismatch")
    require(evidence.get("complete") is True, "final diagnostic evidence incomplete")
    device = evidence.get("device")
    target = contract["target"]
    require(
        isinstance(device, dict)
        and device.get("manufacturer") == target["manufacturer"]
        and device.get("model") == target["model"]
        and isinstance(device.get("sdkInt"), int)
        and device["sdkInt"] >= target["minimumSdkInt"]
        and bool(device.get("buildFingerprint")),
        "final diagnostic device identity mismatch",
    )
    thermal_names = {
        0: "none",
        1: "light",
        2: "moderate",
        3: "severe",
        4: "critical",
        5: "emergency",
        6: "shutdown",
    }
    require(
        thermal_names.get(device.get("maximumThermalStatusRaw"))
        == device.get("maximumThermalStatusName"),
        "final diagnostic thermal identity mismatch",
    )
    fixture = evidence.get("fixture")
    expected_fixture = contract["fixture"]
    require(
        isinstance(fixture, dict)
        and fixture.get("sha256") == expected_fixture["wavSha256"]
        and fixture.get("sha256After") == expected_fixture["wavSha256"]
        and fixture.get("sampleRate") == expected_fixture["sampleRate"]
        and isinstance(fixture.get("totalSamples"), int)
        and fixture.get("consumedSamples") == fixture.get("totalSamples"),
        "final diagnostic fixture was not completely consumed",
    )
    configuration = evidence.get("configuration")
    require(isinstance(configuration, dict), "final diagnostic configuration missing")
    expected_configuration = {
        "mode": "OFFICIAL_PARITY",
        "numThreads": arm["numThreads"],
        "directFullFixtureProcess": True,
        "usesWindowing": False,
        "usesExternalEmbedding": False,
        "usesReconciliation": False,
        "segmentationSha256": arm["segmentation"]["sha256"],
        "embeddingSha256": arm["embedding"]["sha256"],
        "clusteringAlgorithm": arm["clustering"]["algorithm"],
        "numSpeakers": arm["clustering"]["numSpeakers"],
        "clusteringThreshold": arm["clustering"]["threshold"],
        "minDurationOn": arm["minDurationOn"],
        "minDurationOff": arm["minDurationOff"],
    }
    require(
        configuration == expected_configuration,
        "official parity evidence changed windowing, embedding, reconciliation, or another frozen input",
    )
    transcript = evidence.get("transcriptSnapshot")
    require(
        isinstance(transcript, dict)
        and is_sha256(transcript.get("beforeSha256"))
        and transcript.get("beforeSha256") == transcript.get("afterSha256"),
        "transcript snapshot changed during final diagnostic",
    )
    timings = evidence.get("timings")
    require(
        isinstance(timings, dict)
        and isinstance(timings.get("elapsedMs"), (int, float))
        and timings["elapsedMs"] > 0
        and isinstance(timings.get("rtf"), (int, float))
        and timings["rtf"] > 0,
        "final diagnostic timings invalid",
    )
    resources = evidence.get("resources")
    require(
        isinstance(resources, dict)
        and all(
            isinstance(resources.get(field), int) and resources[field] >= 0
            for field in (
                "baselinePssKiB",
                "peakPssKiB",
                "peakJavaBytes",
                "peakNativeBytes",
            )
        ),
        "final diagnostic resource measurements invalid",
    )
    turns = evidence.get("turns")
    require(isinstance(turns, list), "final diagnostic turns missing")
    duration = fixture["totalSamples"] / fixture["sampleRate"]
    for index, turn in enumerate(turns):
        require(isinstance(turn, dict), f"turns[{index}] invalid")
        start = turn.get("startSeconds")
        end = turn.get("endSeconds")
        require(
            isinstance(start, (int, float))
            and isinstance(end, (int, float))
            and 0 <= start < end <= duration + 0.02
            and isinstance(turn.get("speakerIndex"), int)
            and turn["speakerIndex"] >= 0,
            f"turns[{index}] invalid",
        )


def validate_final_diagnostic_repository(
    contract: dict[str, Any],
    repository_root: Path = ROOT,
) -> dict[str, Any]:
    """Validate terminal diagnostic evidence and summary files in the repository."""
    validate_final_diagnostic_contract(contract)
    summary_path = contract.get("summaryPath")
    require(
        isinstance(summary_path, str)
        and summary_path.startswith("benchmark/evidence/")
        and Path(summary_path).is_absolute() is False,
        "final diagnostic summary path must be repository-relative evidence",
    )
    summary_file = repository_root / summary_path
    require(summary_file.is_file(), "final diagnostic summary file missing")
    summary_bytes = summary_file.read_bytes()
    require(
        hashlib.sha256(summary_bytes).hexdigest() == contract.get("summarySha256"),
        "final diagnostic summary hash mismatch",
    )
    summary = json.loads(summary_bytes)
    require(
        summary.get("contractId") == contract.get("contractId")
        and summary.get("terminalDisposition") == contract.get("terminalDisposition")
        and summary.get("nextCandidate") is None,
        "final diagnostic summary disposition mismatch",
    )
    summary_arms = {
        item.get("armId"): item
        for item in summary.get("arms") or []
        if isinstance(item, dict)
    }
    contract_arms = {
        item.get("id"): item
        for item in contract.get("parityArms") or []
        if isinstance(item, dict)
    }
    require(
        set(summary_arms) == set(contract_arms),
        "final diagnostic summary arm set mismatch",
    )
    for arm_id, arm in contract_arms.items():
        summary_arm = summary_arms[arm_id]
        require(
            summary_arm.get("status") == arm.get("status"),
            f"{arm_id} summary status mismatch",
        )
        for path_field, hash_field in (
            ("evidencePath", "evidenceSha256"),
            ("evaluationPath", "evaluationSha256"),
        ):
            path = arm.get(path_field)
            require(
                isinstance(path, str)
                and path.startswith("benchmark/evidence/")
                and Path(path).is_absolute() is False,
                f"{arm_id} {path_field} must be repository-relative evidence",
            )
            evidence_file = repository_root / path
            require(evidence_file.is_file(), f"{arm_id} {path_field} file missing")
            require(
                hashlib.sha256(evidence_file.read_bytes()).hexdigest()
                == arm.get(hash_field),
                f"{arm_id} {path_field} hash mismatch",
            )
        raw = json.loads((repository_root / arm["evidencePath"]).read_text())
        validate_final_diagnostic_evidence(raw, arm, contract)
        evaluation = json.loads(
            (repository_root / arm["evaluationPath"]).read_text()
        )
        require(
            evaluation.get("armId") == arm_id
            and evaluation.get("status") == arm.get("status")
            and evaluation.get("evidenceSha256") == arm.get("evidenceSha256"),
            f"{arm_id} evaluation binding mismatch",
        )
        require(
            summary_arm.get("rawEvidencePath") == arm.get("evidencePath")
            and summary_arm.get("rawEvidenceSha256") == arm.get("evidenceSha256")
            and summary_arm.get("evaluationPath") == arm.get("evaluationPath")
            and summary_arm.get("evaluationSha256") == arm.get("evaluationSha256"),
            f"{arm_id} summary evidence binding mismatch",
        )
    expected_disposition = (
        "MOBILE_DIARIZATION_ADMISSIBLE"
        if any(arm.get("status") == "PASS" for arm in contract_arms.values())
        else "MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE"
    )
    require(
        contract.get("terminalDisposition") == expected_disposition,
        "final diagnostic disposition does not match arm statuses",
    )
    return {
        "terminalDisposition": expected_disposition,
        "armCount": len(contract_arms),
    }


def _require_admitted_models(models: dict[str, Any]) -> None:
    for name in ("segmentation", "embedding"):
        model = models[name]
        require(model.get("licenseReviewed") is True, f"{name} license not reviewed")
        require(is_sha256(model.get("artifactSha256")), f"{name} SHA-256 missing")
        require(
            isinstance(model.get("artifactBytes"), int)
            and model["artifactBytes"] > 0,
            f"{name} artifact size missing",
        )


def _require_functional_pass(
    five: dict[str, Any],
    thresholds: dict[str, Any],
) -> None:
    require(five.get("status") == "PASS", "5-minute probe did not pass")
    require(bool(five.get("device")) and bool(five.get("build")), "5-minute identity missing")
    require(is_sha256(five.get("fixtureSha256")), "5-minute fixture hash missing")
    require(is_sha256(five.get("evidenceSha256")), "5-minute evidence hash missing")
    require(
        isinstance(five.get("annotatedSpeechCoverage"), (int, float))
        and five["annotatedSpeechCoverage"]
        >= float(thresholds["minimumAnnotatedSpeechCoverage"]),
        "5-minute coverage below 80%",
    )
    require(
        isinstance(five.get("der"), (int, float))
        and five["der"] <= float(thresholds["maximumDer"]),
        "5-minute DER above 30%",
    )
    require(five.get("orderedInBoundsTurns") is True, "turn bounds failed")
    require(five.get("overlapRepresented") is True, "overlap representation failed")
    require(
        five.get("noSpeakerInPreregisteredSilence") is True,
        "speaker was fabricated in preregistered silence",
    )
    require(
        five.get("meetingGlobalSpeakerKeys") is True,
        "meeting-global speaker identity failed",
    )
    before = five.get("transcriptSnapshotBeforeSha256")
    after = five.get("transcriptSnapshotAfterSha256")
    require(
        is_sha256(before) and is_sha256(after),
        "transcript snapshot hashes missing",
    )
    require(before == after, "transcript was altered")


def _require_resource_pass(
    resource: dict[str, Any],
    thresholds: dict[str, Any],
) -> None:
    require(resource.get("status") == "PASS", "120-minute probe did not pass")
    require(
        bool(resource.get("device")) and bool(resource.get("build")),
        "120-minute identity missing",
    )
    require(is_sha256(resource.get("fixtureSha256")), "120-minute fixture hash missing")
    require(is_sha256(resource.get("evidenceSha256")), "120-minute evidence hash missing")
    require(resource.get("completed") is True, "120-minute probe incomplete")
    require(resource.get("oom") is False, "120-minute probe OOM")
    require(resource.get("anr") is False, "120-minute probe ANR")
    require(
        isinstance(resource.get("rtf"), (int, float))
        and resource["rtf"] <= float(thresholds["maximumRtf"]),
        "120-minute RTF above 0.5",
    )
    require(
        isinstance(resource.get("incrementalPeakRssMiB"), (int, float))
        and resource["incrementalPeakRssMiB"]
        <= float(thresholds["maximumIncrementalPeakRssMiB"]),
        "120-minute RSS above 384 MiB",
    )
    require(
        resource.get("maximumThermalStatus") in {"none", "light", "moderate"},
        "120-minute thermal status reached severe",
    )


def _load_default_contract() -> dict[str, Any]:
    return json.loads(DEFAULT_CONTRACT.read_text(encoding="utf-8"))


def deferred_status(failed_gates: list[str]) -> str:
    gates = set(failed_gates)
    if "NO_ADMISSIBLE_CANDIDATE" in gates:
        return "DEFERRED_NO_ADMISSIBLE_CANDIDATE"
    if "MODEL_AND_FIXTURE" in gates:
        return "DEFERRED_MODEL_AND_FIXTURE_GATE"
    if "LICENSE" in gates:
        return "DEFERRED_LICENSE_GATE"
    if "FUNCTIONAL" in gates:
        return "DEFERRED_FUNCTIONAL_GATE"
    if "RESOURCE" in gates:
        return "DEFERRED_RESOURCE_GATE"
    raise ManifestError("deferred result must include a failed gate")


def validate_manifest(
    manifest: dict[str, Any],
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    contract = contract or _load_default_contract()
    require(contract.get("schemaVersion") == 2, "contract schemaVersion must be 2")
    require(manifest.get("schemaVersion") == 2, "schemaVersion must be 2")
    require(
        manifest.get("contractId") == contract.get("contractId"),
        "contractId mismatch",
    )
    candidate = contract.get("candidate") or {}
    require(
        manifest.get("candidateId") == candidate.get("id"),
        "candidateId mismatch",
    )
    configuration_candidates = candidate.get("configurationCandidates")
    frozen_configuration = candidate.get("frozenConfiguration")
    require(
        isinstance(configuration_candidates, list)
        and 1 <= len(configuration_candidates) <= 6
        and all(isinstance(item, dict) for item in configuration_candidates),
        "candidate must preregister one to six configurations",
    )
    require(
        isinstance(frozen_configuration, dict)
        and frozen_configuration in configuration_candidates,
        "frozenConfiguration must be preregistered",
    )
    status = manifest.get("status")
    verified = manifest.get("verified")
    eligible = manifest.get("eligibleForProductization")
    product_available = manifest.get("productAvailable")
    failed_gates = manifest.get("failedGates")
    require(
        isinstance(failed_gates, list)
        and all(gate in ALLOWED_FAILED_GATES for gate in failed_gates)
        and len(failed_gates) == len(set(failed_gates)),
        "failedGates must contain unique allowed gates",
    )
    require(product_available is False, "productAvailable must remain false")
    product_state = manifest.get("productState") or {}
    require(
        product_state.get("modelsPackaged") is False,
        "speaker models must not be packaged by admission",
    )
    require(
        product_state.get("productEntrance") is False,
        "speaker product entrance must remain closed",
    )
    require(
        product_state.get("persistsVoiceprints") is False,
        "voiceprint persistence is forbidden",
    )

    runtime = candidate.get("runtime") or {}
    require(is_sha256(runtime.get("sha256")), "runtime SHA-256 is required")
    require(
        isinstance(runtime.get("bytes"), int) and runtime["bytes"] > 0,
        "runtime byte size is required",
    )
    require(bool(runtime.get("version")), "runtime version is required")

    models = candidate.get("models") or {}
    for name in ("segmentation", "embedding"):
        model = models.get(name) or {}
        require(bool(model.get("source")), f"{name} source is required")
        require(bool(model.get("sourceVersion")), f"{name} sourceVersion is required")
        require(bool(model.get("license")), f"{name} license record is required")
        require(bool(model.get("licenseSource")), f"{name} license source is required")
        if model.get("licenseReviewed") is True:
            require(is_sha256(model.get("artifactSha256")), f"{name} SHA-256 missing")
            require(
                isinstance(model.get("artifactBytes"), int)
                and model["artifactBytes"] > 0,
                f"{name} artifact size missing",
            )

    _require_admitted_models(models)
    fixtures = contract.get("fixtures") or {}
    thresholds = contract.get("thresholds") or {}
    probes = manifest.get("probes") or {}
    five = probes.get("fiveMinute") or {}
    thirty = probes.get("thirtyMinute") or {}
    resource = probes.get("oneHundredTwentyMinute") or {}
    require(
        thirty.get("status") == "SKIPPED_BY_PLAN",
        "30-minute probe must remain SKIPPED_BY_PLAN in the development gate",
    )
    require(
        five.get("fixtureSha256") == (fixtures.get("fiveMinute") or {}).get("wavSha256"),
        "5-minute fixture does not match contract",
    )
    require(
        resource.get("fixtureSha256")
        == (fixtures.get("oneHundredTwentyMinute") or {}).get("wavSha256"),
        "120-minute fixture does not match contract",
    )

    if status == PASS_STATUS:
        require(
            verified is True and eligible is True,
            "VERIFIED must be eligible for productization",
        )
        require(failed_gates == [], "VERIFIED cannot contain failed gates")
        require(
            is_sha256(manifest.get("evaluationEvidenceSha256")),
            "evaluation evidence hash missing",
        )
        _require_functional_pass(five, thresholds["fiveMinute"])
        _require_resource_pass(resource, thresholds["oneHundredTwentyMinute"])
    else:
        require(
            status in DEFERRED_STATUSES,
            "status must be VERIFIED or an allowed deferred state",
        )
        require(
            verified is False and eligible is False,
            "deferred status cannot be eligible for productization",
        )
        require(status == deferred_status(failed_gates), "status does not match failedGates")
        require(bool(manifest.get("reason")), "deferred reason is required")
        require(bool(manifest.get("alternativesReview")), "alternatives review is required")
        if "FUNCTIONAL" in failed_gates:
            require(five.get("status") == "FAIL", "functional gate must record 5-minute FAIL")
        elif status == "DEFERRED_RESOURCE_GATE":
            _require_functional_pass(five, thresholds["fiveMinute"])
        if "RESOURCE" in failed_gates:
            require(
                resource.get("status") == "FAIL",
                "resource gate must record 120-minute FAIL",
            )
        require(bool(five.get("reason")), "deferred 5-minute reason is required")
        require(bool(resource.get("reason")), "deferred 120-minute reason is required")
        if status == "DEFERRED_NO_ADMISSIBLE_CANDIDATE":
            evidence_files = manifest.get("evidenceFiles")
            require(
                isinstance(evidence_files, list)
                and {
                    item.get("role")
                    for item in evidence_files
                    if isinstance(item, dict)
                }
                == {
                    "CURRENT_FUNCTIONAL_SCREEN",
                    "CURRENT_SCREENING_EVALUATION",
                    "FALLBACK_FUNCTIONAL_SCREEN",
                    "FALLBACK_SCREENING_EVALUATION",
                    "RESOURCE_EXECUTION_DISPOSITION",
                },
                "no-admissible-candidate evidenceFiles are incomplete",
            )
            for item in evidence_files:
                path = item.get("path")
                require(
                    isinstance(path, str)
                    and bool(path)
                    and not Path(path).is_absolute()
                    and ".." not in Path(path).parts,
                    "evidence file path is unsafe",
                )
                require(is_sha256(item.get("sha256")), "evidence file hash missing")

    return {
        "status": status,
        "verified": verified,
        "eligibleForProductization": eligible,
        "productAvailable": product_available,
        "failedGates": failed_gates,
    }


def validate_deferred_evidence_summary(
    manifest: dict[str, Any],
    evidence_by_role: dict[str, dict[str, Any]],
) -> None:
    """Prove the no-candidate manifest summary is copied from committed evidence."""
    if manifest.get("status") != "DEFERRED_NO_ADMISSIBLE_CANDIDATE":
        return

    current_raw = evidence_by_role["CURRENT_FUNCTIONAL_SCREEN"]
    current_evaluation = evidence_by_role["CURRENT_SCREENING_EVALUATION"]
    fallback_raw = evidence_by_role["FALLBACK_FUNCTIONAL_SCREEN"]
    fallback_evaluation = evidence_by_role["FALLBACK_SCREENING_EVALUATION"]
    resource = evidence_by_role["RESOURCE_EXECUTION_DISPOSITION"]
    evidence_files = {
        item["role"]: item
        for item in manifest["evidenceFiles"]
    }

    for raw, evaluation, raw_role, evaluation_role in (
        (
            current_raw,
            current_evaluation,
            "CURRENT_FUNCTIONAL_SCREEN",
            "CURRENT_SCREENING_EVALUATION",
        ),
        (
            fallback_raw,
            fallback_evaluation,
            "FALLBACK_FUNCTIONAL_SCREEN",
            "FALLBACK_SCREENING_EVALUATION",
        ),
    ):
        require(
            evaluation.get("decision") == "REJECT_CURRENT_CANDIDATE"
            and evaluation.get("failedGates") == ["FUNCTIONAL", "PROJECTED_RTF"],
            f"{evaluation_role} decision drifted",
        )
        require(
            evaluation.get("candidateId") == raw.get("candidateId")
            and evaluation.get("contractSha256") == raw.get("contractSha256"),
            f"{evaluation_role} identity drifted",
        )
        require(
            (evaluation.get("fiveMinute") or {}).get("evidenceSha256")
            == evidence_files[raw_role]["sha256"],
            f"{evaluation_role} raw evidence link drifted",
        )

    require(
        manifest.get("evaluationEvidenceSha256")
        == evidence_files["FALLBACK_SCREENING_EVALUATION"]["sha256"],
        "manifest evaluationEvidenceSha256 drifted",
    )
    five = (manifest.get("probes") or {}).get("fiveMinute") or {}
    evaluated_five = fallback_evaluation.get("fiveMinute") or {}
    field_pairs = {
        "status": "status",
        "annotatedSpeechCoverage": "annotatedSpeechCoverage",
        "der": "der",
        "orderedInBoundsTurns": "orderedInBoundsTurns",
        "overlapRepresented": "overlapRepresented",
        "noSpeakerInPreregisteredSilence": "noSpeakerInPreregisteredSilence",
        "meetingGlobalSpeakerKeys": "meetingGlobalSpeakerKeys",
        "transcriptSnapshotBeforeSha256": "transcriptSnapshotBeforeSha256",
        "transcriptSnapshotAfterSha256": "transcriptSnapshotAfterSha256",
    }
    for manifest_field, evaluation_field in field_pairs.items():
        require(
            five.get(manifest_field) == evaluated_five.get(evaluation_field),
            f"fiveMinute.{manifest_field} drifted from fallback evaluation",
        )
    require(
        five.get("evidenceSha256")
        == evidence_files["FALLBACK_FUNCTIONAL_SCREEN"]["sha256"],
        "fiveMinute evidenceSha256 drifted",
    )
    require(
        five.get("elapsedMs") == (fallback_evaluation.get("timings") or {}).get("totalMs"),
        "fiveMinute elapsedMs drifted",
    )
    projected = fallback_evaluation.get("projectedOneHundredTwentyMinute") or {}
    require(
        five.get("projectedOneHundredTwentyMinuteRtf") == projected.get("projectedRtf"),
        "fiveMinute projected RTF drifted",
    )

    resource_probe = (manifest.get("probes") or {}).get("oneHundredTwentyMinute") or {}
    require(
        resource.get("source") == "deterministic_screening_decision"
        and resource.get("executed") is False
        and resource.get("decisionComplete") is True,
        "resource execution disposition is invalid",
    )
    for field in ("contractId", "contractSha256", "candidateId"):
        require(
            resource.get(field) == fallback_raw.get(field),
            f"resource {field} drifted",
        )
    require(
        resource.get("functionalEvidenceSha256")
        == evidence_files["FALLBACK_FUNCTIONAL_SCREEN"]["sha256"],
        "resource functional evidence link drifted",
    )
    require(
        resource.get("screeningEvaluationSha256")
        == evidence_files["FALLBACK_SCREENING_EVALUATION"]["sha256"],
        "resource screening evaluation link drifted",
    )
    require(
        resource_probe.get("evidenceSha256")
        == evidence_files["RESOURCE_EXECUTION_DISPOSITION"]["sha256"],
        "resource probe evidenceSha256 drifted",
    )
    for field in ("executionDisposition", "projectedRtf"):
        require(
            resource_probe.get(field) == resource.get(field),
            f"resource probe {field} drifted",
        )
    require(
        resource_probe.get("completed") is False,
        "skipped resource probe cannot be complete",
    )
