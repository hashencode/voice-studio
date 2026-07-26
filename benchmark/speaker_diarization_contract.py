"""Validate the persistent S3 speaker-admission contract and result manifest."""

from __future__ import annotations

import json
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
