#!/usr/bin/env python3
"""Validate the approved S2 Mobile Core product-scope contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs" / "product" / "s2-mobile-core-scope.json"
DECISION_ID = "S2-MOBILE-CORE-2026-07-25"
EXPECTED_ORIGINAL_S2_BASELINE_IDS = {
    "ASR-004",
    "ASR-005",
    "ASR-006",
    "ASR-007",
    "ASR-008",
    "EXP-004",
    "EXP-009",
    "POST-003",
    "POST-004",
    "POST-005",
    "POST-006",
    "POST-008",
    "REC-006",
    "REC-008",
    "REC-009",
    "REC-010",
    "SEC-003",
    "SEC-004",
    "TIM-001",
    "TIM-002",
    "TIM-003",
}
EXPECTED_OVERALL_BLOCKERS = {
    "RELEASE-HIGH-END-COMPATIBILITY",
    "EXP-005-ANDROID-PRODUCTION-RELEASE",
    "S2-MOBILE-CORE",
    "RELEASE-DELIVERY",
}
EXPECTED_CURRENT_BLOCKED_GATE_IDS = {"ASR-005-TIMESTAMP-INDEPENDENT"}
EXPECTED_MOBILE_CORE_GATE_COUNT = 18
EXPECTED_MOBILE_CORE_PASS_COUNT = 17
EXPECTED_ITEM_DISPOSITIONS_AND_DEFERRED_TARGETS = {
    "ASR-004": ("split", ("PC_TEXT_QUALITY",)),
    "ASR-005": ("mandatory", ()),
    "ASR-006": ("split", ("PC_ASR",)),
    "ASR-007": ("deferred", ("PC_ASR",)),
    "ASR-008": ("deferred", ("ADVANCED_AUDIO",)),
    "EXP-004": ("mandatory", ()),
    "EXP-009": ("split", ("ADVANCED_SERVICE",)),
    "POST-003": ("split", ("S3",)),
    "POST-004": ("mandatory", ()),
    "POST-005": ("split", ("S3",)),
    "POST-006": ("mandatory", ()),
    "POST-008": ("mandatory", ()),
    "REC-006": ("mandatory", ()),
    "REC-008": ("mandatory", ()),
    "REC-009": ("deferred", ("MOBILE_HARDWARE_COMPATIBILITY",)),
    "REC-010": ("mandatory", ()),
    "SEC-003": ("mandatory", ()),
    "SEC-004": ("mandatory", ()),
    "TIM-001": ("mandatory", ()),
    "TIM-002": ("mandatory", ()),
    "TIM-003": ("mandatory", ()),
}
EXPECTED_AUTHORITY_MARKERS = {
    "README.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "NOT RELEASE-READY",
    },
    "docs/product/meeting-voice-recognition-prd-v1.0.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "DEFERRED_TO_PC",
        "BLOCKED",
    },
    "docs/product/s2-closure-status.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "BLOCKED",
        "NOT RELEASE-READY",
    },
    "docs/product/s2-asr-closure-status.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "DEFERRED_TO_PC",
        "BLOCKED",
    },
    "docs/product/mobile-capability-matrix.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "DEFERRED_NOT_PASSED",
    },
    "docs/REAL_DEVICE_REGRESSION_MATRIX.md": {
        DECISION_ID,
        "S2 Mobile Core",
        "ASR-005-TIMESTAMP-INDEPENDENT",
    },
    "docs/BETA_RELEASE_CHECKLIST.md": {
        DECISION_ID,
        "ASR-005-TIMESTAMP-INDEPENDENT",
        "Deferred advanced",
    },
    "benchmark/S2_ASR_CAPABILITY_REVIEW.md": {
        DECISION_ID,
        "S2 Mobile Core",
    },
    "benchmark/S2_ITN_BLOCKER.md": {
        DECISION_ID,
        "DEFERRED_TO_PC",
    },
    "benchmark/S2_CONFIDENCE_REVIEW.md": {
        DECISION_ID,
        "DEFERRED_TO_PC",
    },
    "benchmark/S2_HOTWORD_BLOCKER.md": {
        DECISION_ID,
        "DEFERRED_TO_PC",
    },
    "benchmark/S2_ENHANCEMENT_REVIEW.md": {
        DECISION_ID,
        "DEFERRED_TO_ADVANCED",
    },
    "benchmark/TIMESTAMP_REVIEW.md": {
        DECISION_ID,
        "ASR-005-TIMESTAMP-INDEPENDENT",
    },
    "benchmark/S2_PHYSICAL_EVIDENCE.md": {
        DECISION_ID,
        "S2 Mobile Core",
    },
}
ALLOWED_DISPOSITIONS = {"mandatory", "split", "deferred"}
ALLOWED_CORE_STATUSES = {"PASS", "BLOCKED", "NOT_APPLICABLE"}
ALLOWED_DEFERRED_TARGETS = {
    "PC_ASR",
    "PC_TEXT_QUALITY",
    "ADVANCED_AUDIO",
    "ADVANCED_SERVICE",
    "MOBILE_HARDWARE_COMPATIBILITY",
    "S3",
}


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _require_nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _require_unique_strings(values: Any, label: str) -> list[str]:
    result = _require_list(values, label)
    if not all(isinstance(item, str) and item for item in result):
        raise ValueError(f"{label} must contain non-empty strings")
    if len(result) != len(set(result)):
        raise ValueError(f"{label} must not contain duplicates")
    return result


def _validate_repo_relative_path(path_value: Any, label: str) -> str:
    path = _require_nonempty_string(path_value, label)
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts:
        raise ValueError(f"{label} must be a safe repo-relative path")
    return path


def _item_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    items = _require_list(manifest.get("items"), "items")
    by_id: dict[str, dict[str, Any]] = {}
    for index, raw_item in enumerate(items):
        item = _require_mapping(raw_item, f"items[{index}]")
        item_id = _require_nonempty_string(item.get("id"), f"items[{index}].id")
        if item_id in by_id:
            raise ValueError(f"duplicate item id: {item_id}")
        by_id[item_id] = item
    return by_id


def _validate_items(manifest: dict[str, Any]) -> tuple[set[str], set[str]]:
    baseline_ids = set(
        _require_unique_strings(
            manifest.get("originalS2BaselineIds"),
            "originalS2BaselineIds",
        )
    )
    if baseline_ids != EXPECTED_ORIGINAL_S2_BASELINE_IDS:
        missing = sorted(EXPECTED_ORIGINAL_S2_BASELINE_IDS - baseline_ids)
        extra = sorted(baseline_ids - EXPECTED_ORIGINAL_S2_BASELINE_IDS)
        raise ValueError(
            "originalS2BaselineIds must exactly match the immutable "
            f"2026-07-25 baseline; missing={missing}, extra={extra}"
        )

    items = _item_map(manifest)
    if set(items) != baseline_ids:
        missing = sorted(baseline_ids - set(items))
        extra = sorted(set(items) - baseline_ids)
        raise ValueError(
            f"items must exactly cover originalS2BaselineIds; "
            f"missing={missing}, extra={extra}"
        )

    gate_ids: set[str] = set()
    blocked_gate_ids: set[str] = set()
    for item_id, item in items.items():
        disposition = item.get("disposition")
        if disposition not in ALLOWED_DISPOSITIONS:
            raise ValueError(f"{item_id}.disposition is invalid: {disposition!r}")
        status = item.get("mobileCoreStatus")
        if status not in ALLOWED_CORE_STATUSES:
            raise ValueError(f"{item_id}.mobileCoreStatus is invalid: {status!r}")
        deferred_parts = _require_list(
            item.get("deferredParts"),
            f"{item_id}.deferredParts",
        )

        if disposition == "deferred":
            if status != "NOT_APPLICABLE":
                raise ValueError(
                    f"{item_id}: deferred items must use NOT_APPLICABLE, not {status}"
                )
            if "mandatoryGateId" in item:
                raise ValueError(f"{item_id}: deferred item cannot declare a gate")
            if not deferred_parts:
                raise ValueError(f"{item_id}: deferred item needs a deferred part")
        else:
            gate_id = _require_nonempty_string(
                item.get("mandatoryGateId"),
                f"{item_id}.mandatoryGateId",
            )
            if gate_id in gate_ids:
                raise ValueError(f"duplicate mandatoryGateId: {gate_id}")
            gate_ids.add(gate_id)
            if status == "NOT_APPLICABLE":
                raise ValueError(
                    f"{item_id}: mandatory/split item cannot be NOT_APPLICABLE"
                )
            _require_nonempty_string(
                item.get("mobileCoreRequirement"),
                f"{item_id}.mobileCoreRequirement",
            )
            if status != "PASS":
                blocked_gate_ids.add(gate_id)
            if disposition == "mandatory" and deferred_parts:
                raise ValueError(
                    f"{item_id}: mandatory item cannot declare deferred parts"
                )
            if disposition == "split" and not deferred_parts:
                raise ValueError(f"{item_id}: split item needs a deferred part")

        for part_index, raw_part in enumerate(deferred_parts):
            part = _require_mapping(
                raw_part,
                f"{item_id}.deferredParts[{part_index}]",
            )
            _require_nonempty_string(
                part.get("capability"),
                f"{item_id}.deferredParts[{part_index}].capability",
            )
            target = part.get("target")
            if target not in ALLOWED_DEFERRED_TARGETS:
                raise ValueError(
                    f"{item_id}.deferredParts[{part_index}].target is invalid: "
                    f"{target!r}"
                )
            if part.get("status") != "DEFERRED_NOT_PASSED":
                raise ValueError(
                    f"{item_id}.deferredParts[{part_index}] must use "
                    "DEFERRED_NOT_PASSED"
                )
            _require_nonempty_string(
                part.get("historicalStatus"),
                f"{item_id}.deferredParts[{part_index}].historicalStatus",
            )

        expected_disposition, expected_targets = (
            EXPECTED_ITEM_DISPOSITIONS_AND_DEFERRED_TARGETS[item_id]
        )
        actual_targets = tuple(part["target"] for part in deferred_parts)
        if disposition != expected_disposition or actual_targets != expected_targets:
            raise ValueError(
                f"{item_id}: approved disposition/deferred targets changed; "
                f"expected=({expected_disposition!r}, {expected_targets!r}), "
                f"actual=({disposition!r}, {actual_targets!r})"
            )

    return gate_ids, blocked_gate_ids


def _validate_statuses(
    manifest: dict[str, Any],
    gate_ids: set[str],
    blocked_gate_ids: set[str],
) -> None:
    mobile_core = _require_mapping(manifest.get("mobileCore"), "mobileCore")
    required_gate_ids = set(
        _require_unique_strings(
            mobile_core.get("requiredGateIds"),
            "mobileCore.requiredGateIds",
        )
    )
    if required_gate_ids != gate_ids:
        raise ValueError(
            "mobileCore.requiredGateIds must exactly match item gates; "
            f"missing={sorted(gate_ids - required_gate_ids)}, "
            f"extra={sorted(required_gate_ids - gate_ids)}"
        )
    if len(gate_ids) != EXPECTED_MOBILE_CORE_GATE_COUNT:
        raise ValueError(
            "current Mobile Core baseline must contain exactly "
            f"{EXPECTED_MOBILE_CORE_GATE_COUNT} gates"
        )
    if mobile_core.get("gateCount") != len(gate_ids):
        raise ValueError(
            "mobileCore.gateCount must match the derived gate count; "
            f"expected={len(gate_ids)}, actual={mobile_core.get('gateCount')!r}"
        )

    declared_blockers = set(
        _require_unique_strings(
            mobile_core.get("remainingBlockers"),
            "mobileCore.remainingBlockers",
        )
    )
    if declared_blockers != blocked_gate_ids:
        raise ValueError(
            "mobileCore.remainingBlockers must match non-PASS gates; "
            f"expected={sorted(blocked_gate_ids)}, "
            f"actual={sorted(declared_blockers)}"
        )
    if blocked_gate_ids != EXPECTED_CURRENT_BLOCKED_GATE_IDS:
        raise ValueError(
            "current Mobile Core baseline must have only ASR-005 blocked; "
            f"actual={sorted(blocked_gate_ids)}"
        )
    pass_count = len(gate_ids) - len(blocked_gate_ids)
    if pass_count != EXPECTED_MOBILE_CORE_PASS_COUNT:
        raise ValueError(
            "current Mobile Core baseline must have exactly "
            f"{EXPECTED_MOBILE_CORE_PASS_COUNT} PASS gates"
        )
    if mobile_core.get("passCount") != pass_count:
        raise ValueError(
            "mobileCore.passCount must match the derived PASS count; "
            f"expected={pass_count}, actual={mobile_core.get('passCount')!r}"
        )
    derived_status = "PASS" if not blocked_gate_ids else "BLOCKED"
    if mobile_core.get("status") != derived_status:
        raise ValueError(
            "derived Mobile Core status mismatch: "
            f"expected {derived_status}, got {mobile_core.get('status')!r}"
        )

    overall = _require_mapping(manifest.get("overallProduct"), "overallProduct")
    if overall.get("status") != "NOT_RELEASE_READY":
        raise ValueError("overallProduct.status must remain NOT_RELEASE_READY")
    overall_blockers = set(
        _require_unique_strings(
            overall.get("blockers"),
            "overallProduct.blockers",
        )
    )
    if overall_blockers != EXPECTED_OVERALL_BLOCKERS:
        raise ValueError(
            "overallProduct.blockers must preserve Mobile Core, release "
            "high-end compatibility, EXP-005 and release-delivery boundaries"
        )
    if overall.get("featureClosure") != "PASS_LOW_AND_MID_DEVICE":
        raise ValueError(
            "overallProduct.featureClosure must preserve the accepted low/mid "
            "device feature PASS"
        )
    if (
        overall.get("releaseDeviceMatrix")
        != "PENDING_HIGH_END_REFERENCE_DEVICE"
    ):
        raise ValueError(
            "overallProduct.releaseDeviceMatrix must keep high-end coverage "
            "as a pending release compatibility gate"
        )


def _validate_special_contracts(manifest: dict[str, Any]) -> None:
    if manifest.get("decisionId") != DECISION_ID:
        raise ValueError(f"decisionId must be {DECISION_ID}")
    if manifest.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    if manifest.get("legacyS2Conclusion") != "BLOCKED_NOT_RELEASE_READY":
        raise ValueError("legacy S2 conclusion cannot be promoted")
    if manifest.get("productionMobileAsr") != "paraformer-zh":
        raise ValueError("production mobile ASR must remain paraformer-zh")

    timestamp = _require_mapping(manifest.get("timestampGate"), "timestampGate")
    if timestamp.get("gateId") != "ASR-005-TIMESTAMP-INDEPENDENT":
        raise ValueError("timestampGate must bind ASR-005 mandatory gate")
    if (
        timestamp.get("executionDisposition")
        != "SKIPPED_PENDING_USER_TEST"
    ):
        raise ValueError(
            "ASR-005 execution must remain skipped pending user testing"
        )
    if timestamp.get("independentReviewRequired") is not True:
        raise ValueError("ASR-005 must require an independent reviewer")
    if timestamp.get("releaseEligible") is not False:
        raise ValueError("ASR-005 cannot be release-eligible without review")
    if timestamp.get("p95ThresholdMs") != 1500:
        raise ValueError("ASR-005 P95 threshold must remain 1500 ms")

    pc = _require_mapping(manifest.get("futurePcAsr"), "futurePcAsr")
    expected_pc_values = {
        "productionModelSelected": False,
        "hotwordDecoderContract": "transducer_modified_beam_search",
        "offlineCandidateClass": "offline_zipformer_transducer",
        "liveCandidateClass": "online_zipformer_transducer",
        "confidenceSignalContract": (
            "raw_score_requires_independent_calibration_and_held_out_validation"
        ),
    }
    for key, expected in expected_pc_values.items():
        if pc.get(key) != expected:
            raise ValueError(f"futurePcAsr.{key} must be {expected!r}")
    sources = _require_unique_strings(
        pc.get("officialSources"),
        "futurePcAsr.officialSources",
    )
    if len(sources) < 3 or not all(
        source.startswith("https://k2-fsa.github.io/sherpa/onnx/")
        for source in sources
    ):
        raise ValueError("futurePcAsr must cite the official Sherpa docs")

    items = _item_map(manifest)
    if items["ASR-008"].get("aecProvided") is not False:
        raise ValueError("ASR-008 must not claim GTCRN provides AEC")


def _validate_documents(manifest: dict[str, Any], root: Path) -> None:
    documents = _require_list(
        manifest.get("authoritativeDocuments"),
        "authoritativeDocuments",
    )
    seen_paths: set[str] = set()
    for index, raw_document in enumerate(documents):
        document = _require_mapping(
            raw_document,
            f"authoritativeDocuments[{index}]",
        )
        relative_path = _validate_repo_relative_path(
            document.get("path"),
            f"authoritativeDocuments[{index}].path",
        )
        if relative_path in seen_paths:
            raise ValueError(f"duplicate authoritative document: {relative_path}")
        seen_paths.add(relative_path)
        markers = _require_unique_strings(
            document.get("requiredMarkers"),
            f"authoritativeDocuments[{index}].requiredMarkers",
        )
        if set(markers) != EXPECTED_AUTHORITY_MARKERS.get(relative_path):
            raise ValueError(
                f"{relative_path}: requiredMarkers must match the approved "
                "authority contract"
            )
        path = root / relative_path
        if not path.is_file():
            raise ValueError(f"authoritative document is missing: {relative_path}")
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                raise ValueError(
                    f"{relative_path} is missing required marker: {marker}"
                )
    if seen_paths != set(EXPECTED_AUTHORITY_MARKERS):
        raise ValueError(
            "authoritativeDocuments must exactly match the approved authority "
            f"set; missing={sorted(set(EXPECTED_AUTHORITY_MARKERS) - seen_paths)}, "
            f"extra={sorted(seen_paths - set(EXPECTED_AUTHORITY_MARKERS))}"
        )


def _validate_prd_trace(manifest: dict[str, Any], root: Path) -> None:
    prd_path = (
        root / "docs" / "product" / "meeting-voice-recognition-prd-v1.0.md"
    )
    lines = prd_path.read_text(encoding="utf-8").splitlines()
    items = _item_map(manifest)
    for item_id, item in items.items():
        prefix = f"| {item_id} |"
        row = next((line for line in lines if line.startswith(prefix)), None)
        if row is None:
            raise ValueError(f"PRD is missing original S2 item: {item_id}")
        if item_id == "ASR-005":
            if (
                "USER_PRE_RELEASE_ACCEPTANCE_ONLY" not in row
                or "BLOCKED" in row
            ):
                raise ValueError(
                    "PRD row ASR-005 must preserve the user-owned pre-release "
                    "acceptance policy without restoring a development blocker"
                )
        elif item["mobileCoreStatus"] == "BLOCKED" and "BLOCKED" not in row:
            raise ValueError(
                f"PRD row {item_id} must preserve the Mobile Core blocker"
            )
        if item["deferredParts"] and "DEFERRED_NOT_PASSED" not in row:
            raise ValueError(
                f"PRD row {item_id} must mark deferred parts "
                "DEFERRED_NOT_PASSED"
            )


def validate_scope_contract(manifest_path: Path, root: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = _require_mapping(manifest, "manifest")
    gate_ids, blocked_gate_ids = _validate_items(manifest)
    _validate_statuses(manifest, gate_ids, blocked_gate_ids)
    _validate_special_contracts(manifest)
    _validate_documents(manifest, root)
    _validate_prd_trace(manifest, root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="scope manifest path",
    )
    args = parser.parse_args()
    validate_scope_contract(args.manifest.resolve(), ROOT)
    print(
        "S2 Mobile Core scope contract: PASS "
        "(Mobile Core BLOCKED; overall NOT_RELEASE_READY)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
