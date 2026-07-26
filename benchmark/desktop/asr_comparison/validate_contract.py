#!/usr/bin/env python3
"""Fail-closed validation for the macOS ASR comparison v2 contract bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


HEX64 = re.compile(r"^[0-9a-f]{64}$")
FIRST_ROUND_CANDIDATES = {
    "sherpa-streaming-zipformer-zh-14m-2023-02-23",
    "sherpa-onnx-paraformer-zh-int8-2025-10-07",
    "sherpa-onnx-paraformer-zh-2024-03-09",
    "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
    "sherpa-onnx-funasr-nano-int8-2025-12-30",
    "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
    "native-funasr-1.3.22-paraformer-vad-punctuation",
}
AMBIGUOUS_IDS = {"funasr", "paraformer", "zipformer", "firered"}
STAGES = {
    "STAGE_0_ADMISSION",
    "STAGE_1_SHORT",
    "STAGE_2_HELD_OUT",
    "STAGE_3_FINALIST",
}
TERMINAL_DISPOSITIONS = {
    "REJECTED_IDENTITY",
    "REJECTED_ARTIFACT_HASH",
    "REJECTED_LICENSE",
    "REJECTED_API_UNSUPPORTED",
    "REJECTED_OFFLINE",
    "REJECTED_SMOKE",
    "REJECTED_HARD_GATE",
    "REJECTED_NO_MATERIAL_BENEFIT",
    "REJECTED_RELIABILITY",
    "CROSS_RUNTIME_CONTROL_COMPLETE",
    "FINALIST_NOT_RECOMMENDED",
    "RECOMMEND_REPLACEMENT",
    "RETAINED_BASELINE",
}


class ContractError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def exact_fields(
    value: dict[str, Any],
    expected: set[str],
    location: str,
    *,
    allow_diagnostics: bool = False,
) -> None:
    allowed = set(expected)
    if allow_diagnostics:
        allowed.add("diagnosticExtensions")
    require(set(value) == allowed, f"{location} fields mismatch")
    if allow_diagnostics:
        diagnostics = value["diagnosticExtensions"]
        require(isinstance(diagnostics, dict), f"{location} diagnostics must be an object")
        require(len(json.dumps(diagnostics)) <= 4096, f"{location} diagnostics are oversized")


def is_hex64(value: Any) -> bool:
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"{path}: root must be an object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_contract(contract: dict[str, Any]) -> None:
    exact_fields(
        contract,
        {
            "schemaVersion",
            "contractId",
            "decisionPlatform",
            "contractState",
            "baselineCandidateId",
            "target",
            "bundleArtifacts",
            "runtimeLanes",
            "profiles",
            "measurementContract",
            "stages",
            "hardGates",
            "materialBenefitRule",
            "scheduling",
            "evidencePolicy",
            "roundOutcomes",
        },
        "contract",
        allow_diagnostics=True,
    )
    require(contract["schemaVersion"] == 2, "contract schemaVersion must be 2")
    require(
        contract["contractId"] == "desktop-processing/macos-asr-comparison-v2",
        "unexpected contractId",
    )
    require(contract["decisionPlatform"] == "macos", "contract target must be macos")
    require(contract["baselineCandidateId"] in FIRST_ROUND_CANDIDATES, "baseline id")

    target = contract["target"]
    exact_fields(
        target,
        {
            "operatingSystem",
            "architecture",
            "cpuFamily",
            "referenceCpuModel",
            "referenceMemoryBytes",
            "targetFingerprintRequiredFields",
        },
        "target",
    )
    require(
        target["operatingSystem"] == "macos"
        and target["architecture"] == "arm64"
        and target["referenceCpuModel"] == "Apple M4",
        "target must bind the Apple M4 macos arm64 reference",
    )
    require(
        target["referenceMemoryBytes"] == 16 * 1024**3,
        "reference memory must be 16 GiB",
    )

    bundle = contract["bundleArtifacts"]
    require(isinstance(bundle, list) and len(bundle) == 3, "bundleArtifacts")
    expected_paths = {
        "benchmark/desktop/asr_comparison/macos_contract.json",
        "benchmark/desktop/asr_comparison/candidates.json",
        "benchmark/desktop/asr_comparison/scoring_contract.json",
    }
    require(
        {entry.get("path") for entry in bundle} == expected_paths,
        "bundle artifact paths mismatch",
    )
    for entry in bundle:
        exact_fields(entry, {"path", "hashAlgorithm", "bindingTime"}, "bundle artifact")
        require(
            entry["hashAlgorithm"] == "sha256"
            and entry["bindingTime"] == "run_start",
            "bundle artifact hash policy mismatch",
        )

    lanes = contract["runtimeLanes"]
    require(isinstance(lanes, list) and lanes, "runtimeLanes must be non-empty")
    lane_ids: set[str] = set()
    for lane in lanes:
        exact_fields(
            lane,
            {"laneId", "kind", "runtime", "target", "members", "rankable", "state"},
            "runtime lane",
        )
        lane_id = lane["laneId"]
        require(isinstance(lane_id, str) and lane_id not in lane_ids, "lane ids")
        lane_ids.add(lane_id)
        require(lane["kind"] == "sherpa_onnx", "only sherpa lanes are rankable lanes")
        exact_fields(
            lane["runtime"],
            {"package", "version", "buildSha256", "apiCharacterization"},
            f"{lane_id}.runtime",
        )
        runtime_hash = lane["runtime"]["buildSha256"]
        require(
            runtime_hash is None or is_hex64(runtime_hash),
            f"{lane_id} runtime hash must be pending or SHA-256",
        )
        require(
            lane["runtime"]["apiCharacterization"]
            in {"PENDING", "SUPPORTED", "UNSUPPORTED"},
            f"{lane_id} API characterization state",
        )
        exact_fields(
            lane["target"],
            {"operatingSystem", "architecture"},
            f"{lane_id}.target",
        )
        require(
            lane["target"]
            == {"operatingSystem": "macos", "architecture": "arm64"},
            f"{lane_id} lane target must be macos arm64",
        )
        members = lane["members"]
        require(
            isinstance(members, list)
            and len(members) == len(set(members))
            and set(members) <= FIRST_ROUND_CANDIDATES,
            f"{lane_id} members are invalid",
        )
        require(
            "native-funasr-1.3.22-paraformer-vad-punctuation" not in members,
            "cross-runtime control cannot enter a sherpa ranking lane",
        )
        if lane["rankable"]:
            require(
                contract["baselineCandidateId"] in members,
                "rankable lane requires a same-lane baseline",
            )
            require(
                lane["runtime"]["apiCharacterization"] == "SUPPORTED"
                and is_hex64(runtime_hash),
                "rankable lane runtime must be characterized and hash-pinned",
            )

    profiles = contract["profiles"]
    exact_fields(
        profiles,
        {"requiredSherpaProfiles", "fixedResourceInvariants", "productFinalist"},
        "profiles",
    )
    require(
        profiles["requiredSherpaProfiles"] == ["recommended", "fixed-resource"],
        "required profile set mismatch",
    )
    fixed = profiles["fixedResourceInvariants"]
    exact_fields(
        fixed,
        {
            "provider",
            "numThreads",
            "concurrency",
            "inputMode",
            "segmentDurationSeconds",
            "pacingPolicy",
            "warmupRuns",
            "measuredRuns",
        },
        "fixedResourceInvariants",
    )
    require(
        fixed
        == {
            "provider": "cpu",
            "numThreads": 2,
            "concurrency": 1,
            "inputMode": "frozen_segments",
            "segmentDurationSeconds": 15,
            "pacingPolicy": "unpaced",
            "warmupRuns": 1,
            "measuredRuns": 5,
        },
        "fixed-resource invariants differ from the frozen contract",
    )
    product_finalist = profiles["productFinalist"]
    exact_fields(
        product_finalist,
        {"enabledAfterStage", "developmentOnlyTuning", "freezeBeforeHeldOut"},
        "productFinalist",
    )
    require(
        product_finalist
        == {
            "enabledAfterStage": "STAGE_2_HELD_OUT",
            "developmentOnlyTuning": True,
            "freezeBeforeHeldOut": True,
        },
        "product-finalist policy mismatch",
    )

    measurement = contract["measurementContract"]
    exact_fields(
        measurement,
        {
            "revision",
            "endToEndWallMilliseconds",
            "loadMilliseconds",
            "decodeMilliseconds",
            "rtf",
            "streamingLatency",
            "segmentLatency",
            "memory",
            "unavailableValuePolicy",
        },
        "measurementContract",
    )
    require(
        measurement["revision"] == "m4-zh-en-measurement-v1",
        "measurement contract revision mismatch",
    )
    require(
        measurement["endToEndWallMilliseconds"]
        == {
            "clock": "monotonic",
            "startBoundary": "worker_request_flushed",
            "endBoundary": "result_event_received",
            "includes": [
                "worker_handshake",
                "runtime_binding",
                "model_load",
                "decode",
            ],
            "excludes": [
                "model_unload",
                "retained_rss_settle",
                "process_teardown",
            ],
        },
        "end-to-end measurement boundary mismatch",
    )
    require(
        measurement["segmentLatency"]
        == {
            "fixedSegmentSeconds": 15,
            "clock": "monotonic",
            "boundary": "segment_accept_start_through_result_retrieval",
            "publishedStatistics": [
                "p50_nearest_rank",
                "p95_nearest_rank",
            ],
        },
        "segment-latency measurement boundary mismatch",
    )
    require(
        measurement["unavailableValuePolicy"]
        == "null_with_explicit_unsupported_not_applicable_or_not_observed_status_never_zero_substitution",
        "unavailable measurement policy mismatch",
    )

    stages = contract["stages"]
    require(
        isinstance(stages, list)
        and [stage.get("stageId") for stage in stages]
        == [
            "STAGE_0_ADMISSION",
            "STAGE_1_SHORT",
            "STAGE_2_HELD_OUT",
            "STAGE_3_FINALIST",
        ],
        "stage order mismatch",
    )
    for stage in stages:
        exact_fields(stage, {"stageId", "purpose", "allowedFixtureRoles"}, "stage")
        require(stage["stageId"] in STAGES, "unknown stage")

    hard_gates = contract["hardGates"]
    exact_fields(
        hard_gates,
        {
            "maxCer",
            "maxWer",
            "maxRtf",
            "maxFinalistIncrementalPeakRssBytes",
            "applyBeforeMaterialBenefit",
        },
        "hardGates",
    )
    require(
        hard_gates["maxCer"] == 0.35
        and hard_gates["maxWer"] == 0.35
        and hard_gates["maxRtf"] == 0.5
        and hard_gates["maxFinalistIncrementalPeakRssBytes"] == 2 * 1024**3
        and hard_gates["applyBeforeMaterialBenefit"] is True,
        "hard gate values mismatch",
    )

    materiality = contract["materialBenefitRule"]
    exact_fields(
        materiality,
        {
            "state",
            "developmentPilotRequired",
            "minimumRelativeMacroLexicalErrorReduction",
            "minimumHardScenariosImproved",
            "alternativeMinimumTerminologyNumericPointGain",
            "maximumRelativeCleanMandarinRegression",
        },
        "materialBenefitRule",
    )
    state_pair = (
        contract["contractState"],
        materiality["state"],
    )
    require(
        state_pair
        in {
            (
                "M4_STAGE_0_ADMITTED_DEVELOPMENT_ASSETS_REQUIRED",
                "PROPOSED_UNFROZEN",
            ),
            (
                "M4_DEVELOPMENT_FROZEN_HELD_OUT_SEALED",
                "FROZEN",
            ),
        },
        "contract/materiality state transition mismatch",
    )
    require(
        materiality["developmentPilotRequired"] is True
        and 0
        < materiality["minimumRelativeMacroLexicalErrorReduction"]
        <= 1
        and isinstance(
            materiality["minimumHardScenariosImproved"],
            int,
        )
        and not isinstance(
            materiality["minimumHardScenariosImproved"],
            bool,
        )
        and materiality["minimumHardScenariosImproved"] >= 1
        and 0
        < materiality["alternativeMinimumTerminologyNumericPointGain"]
        <= 1
        and 0
        <= materiality["maximumRelativeCleanMandarinRegression"]
        <= 1,
        "material benefit rule values are invalid",
    )

    scheduling = contract["scheduling"]
    exact_fields(
        scheduling,
        {
            "seed",
            "shortWarmupRuns",
            "shortMeasuredRuns",
            "rotateCandidateProfileOrder",
            "maxConcurrentWorkers",
            "longFixtureSeconds",
            "repeatLongRunWithinLimitFraction",
        },
        "scheduling",
    )
    require(
        scheduling["shortWarmupRuns"] == 1
        and scheduling["shortMeasuredRuns"] == 5
        and scheduling["maxConcurrentWorkers"] == 1
        and scheduling["longFixtureSeconds"] == 7200,
        "scheduling contract mismatch",
    )
    require(
        set(contract["roundOutcomes"])
        == {
            "RETAIN_BASELINE_NO_MATERIAL_BENEFIT",
            "RETAIN_BASELINE_NO_OPERATIONAL_FINALIST",
            "RECOMMEND_REPLACEMENT",
            "ROUND_BLOCKED",
        },
        "round outcome enum mismatch",
    )


def validate_scoring(scoring: dict[str, Any], contract: dict[str, Any]) -> None:
    exact_fields(
        scoring,
        {
            "schemaVersion",
            "scoringContractId",
            "comparisonContractId",
            "normalization",
            "lexicalMetrics",
            "displayMetrics",
            "scenarioAggregation",
            "nonSpeech",
            "invalidMetricPolicy",
        },
        "scoring contract",
        allow_diagnostics=True,
    )
    require(scoring["schemaVersion"] == 2, "scoring schemaVersion")
    require(
        scoring["comparisonContractId"] == contract["contractId"],
        "scoring comparison contract mismatch",
    )
    normalization = scoring["normalization"]
    exact_fields(
        normalization,
        {
            "unicode",
            "latinCase",
            "whitespace",
            "lexicalPunctuation",
            "englishTokenization",
        },
        "normalization",
    )
    require(
        normalization["unicode"] == "NFKC"
        and normalization["latinCase"] == "casefold"
        and normalization["lexicalPunctuation"] == "exclude",
        "lexical normalization mismatch",
    )
    require(
        set(scoring["lexicalMetrics"])
        == {
            "cer",
            "wer",
            "substitutions",
            "deletions",
            "insertions",
            "exactUtteranceRate",
            "terminologyRecall",
            "numericEventAccuracy",
            "codeSwitchZhCer",
            "codeSwitchEnWer",
        },
        "lexical metric set mismatch",
    )
    require(
        set(scoring["displayMetrics"])
        == {
            "punctuationPrecision",
            "punctuationRecall",
            "punctuationF1",
            "itnEventAccuracy",
        },
        "display metric set mismatch",
    )
    require(
        scoring["scenarioAggregation"]
        == {
            "fixtureToScenario": "arithmetic_mean",
            "scenarioToMacro": "equal_weight_arithmetic_mean",
            "durationWeighting": False,
            "preserveIndividualRuns": True,
        },
        "scenario aggregation must be macro and not duration weighted",
    )


def validate_candidate_registry(
    registry: dict[str, Any], contract: dict[str, Any]
) -> None:
    exact_fields(
        registry,
        {
            "schemaVersion",
            "registryId",
            "comparisonContractId",
            "frozenCandidateSet",
            "candidates",
            "terminalDispositionEnums",
        },
        "candidate registry",
        allow_diagnostics=True,
    )
    require(registry["schemaVersion"] == 2, "candidate schemaVersion")
    require(
        registry["comparisonContractId"] == contract["contractId"],
        "candidate contract mismatch",
    )
    candidates = registry["candidates"]
    require(isinstance(candidates, list), "candidate list missing")
    candidate_ids = [candidate.get("candidateId") for candidate in candidates]
    require(
        len(candidate_ids) == len(set(candidate_ids))
        and set(candidate_ids) == FIRST_ROUND_CANDIDATES
        and set(registry["frozenCandidateSet"]) == FIRST_ROUND_CANDIDATES,
        "first-round candidate set mismatch",
    )
    require(
        not (set(candidate_ids) & AMBIGUOUS_IDS),
        "ambiguous candidate ids are forbidden",
    )
    require(
        set(registry["terminalDispositionEnums"]) == TERMINAL_DISPOSITIONS,
        "terminal disposition enum mismatch",
    )

    lanes = {lane["laneId"]: lane for lane in contract["runtimeLanes"]}
    fixed_invariants = contract["profiles"]["fixedResourceInvariants"]
    baseline_id = contract["baselineCandidateId"]
    for candidate in candidates:
        exact_fields(
            candidate,
            {
                "candidateId",
                "displayName",
                "runtimeKind",
                "family",
                "modelDate",
                "role",
                "runtimeLaneIds",
                "source",
                "artifacts",
                "license",
                "capabilities",
                "profiles",
                "admission",
            },
            f"candidate {candidate.get('candidateId')}",
            allow_diagnostics=True,
        )
        candidate_id = candidate["candidateId"]
        require(
            candidate_id not in AMBIGUOUS_IDS and len(candidate_id) >= 12,
            f"{candidate_id}: candidate identity is ambiguous",
        )
        exact_fields(
            candidate["source"],
            {"officialUrl", "retrievedAt", "screeningContextOnly"},
            f"{candidate_id}.source",
        )
        require(
            candidate["source"]["officialUrl"].startswith("https://"),
            f"{candidate_id}: official source URL required",
        )
        artifacts = candidate["artifacts"]
        require(isinstance(artifacts, list) and artifacts, f"{candidate_id}: artifacts")
        artifact_ids: set[str] = set()
        for artifact in artifacts:
            exact_fields(
                artifact,
                {
                    "componentId",
                    "fileRole",
                    "sourceUrl",
                    "sha256",
                    "hashState",
                },
                f"{candidate_id}.artifact",
            )
            require(
                artifact["componentId"] not in artifact_ids,
                f"{candidate_id}: duplicate artifact",
            )
            artifact_ids.add(artifact["componentId"])
            require(
                artifact["sha256"] is None or is_hex64(artifact["sha256"]),
                f"{candidate_id}: artifact hash invalid",
            )
            require(
                artifact["hashState"]
                == ("PINNED" if artifact["sha256"] is not None else "PENDING_PROVISIONING"),
                f"{candidate_id}: artifact hash state mismatch",
            )
        license_info = candidate["license"]
        exact_fields(
            license_info,
            {"spdx", "disposition", "noticeSource"},
            f"{candidate_id}.license",
        )
        require(
            license_info["disposition"]
            in {"ACCEPTED_FOR_BENCHMARK", "REVIEW_REQUIRED", "REJECTED"},
            f"{candidate_id}: license disposition",
        )
        capabilities = candidate["capabilities"]
        exact_fields(
            capabilities,
            {
                "streaming",
                "timestamps",
                "partialResults",
                "endpointing",
                "hotwords",
                "punctuation",
                "itn",
                "seededGeneration",
            },
            f"{candidate_id}.capabilities",
        )
        require(
            all(isinstance(value, bool) for value in capabilities.values()),
            f"{candidate_id}: capabilities must be booleans",
        )
        admission = candidate["admission"]
        exact_fields(
            admission,
            {
                "status",
                "apiSupport",
                "offlineVerified",
                "smokeDecode",
                "terminalDisposition",
                "reasons",
            },
            f"{candidate_id}.admission",
        )
        require(
            admission["status"]
            in {
                "PENDING_ARTIFACTS",
                "PENDING_CHARACTERIZATION",
                "PENDING_SMOKE",
                "ADMITTED",
                "REJECTED",
            },
            f"{candidate_id}: admission status",
        )
        require(
            admission["apiSupport"] in {"PENDING", "SUPPORTED", "UNSUPPORTED"},
            f"{candidate_id}: API support",
        )
        require(
            admission["offlineVerified"] in {"PENDING", "PASS", "FAIL"}
            and admission["smokeDecode"] in {"PENDING", "PASS", "FAIL"},
            f"{candidate_id}: admission probe state",
        )
        if admission["status"] == "ADMITTED":
            require(
                all(is_hex64(artifact["sha256"]) for artifact in artifacts)
                and license_info["disposition"] == "ACCEPTED_FOR_BENCHMARK"
                and admission["apiSupport"] == "SUPPORTED"
                and admission["offlineVerified"] == "PASS"
                and admission["smokeDecode"] == "PASS",
                f"{candidate_id}: admitted candidate must be hash-pinned and pass admission",
            )
        if admission["status"] == "REJECTED":
            require(
                admission["terminalDisposition"] in TERMINAL_DISPOSITIONS
                and admission["reasons"],
                f"{candidate_id}: rejected candidate needs terminal reasons",
            )
        else:
            require(
                admission["terminalDisposition"] is None,
                f"{candidate_id}: non-rejected admission cannot be terminal",
            )

        lane_ids = candidate["runtimeLaneIds"]
        require(
            isinstance(lane_ids, list)
            and len(lane_ids) == len(set(lane_ids))
            and set(lane_ids) <= set(lanes),
            f"{candidate_id}: runtime lane ids",
        )
        profiles = candidate["profiles"]
        if candidate["runtimeKind"] == "sherpa_onnx":
            require(lane_ids, f"{candidate_id}: sherpa candidate needs a runtime lane")
            require(
                set(profiles) == {"recommended", "fixed-resource"},
                f"{candidate_id}: sherpa profiles mismatch",
            )
            for lane_id in lane_ids:
                require(
                    candidate_id in lanes[lane_id]["members"],
                    f"{candidate_id}: lane membership is not reciprocal",
                )
            fixed_profile = profiles["fixed-resource"]
            _validate_profile(fixed_profile, candidate_id, "fixed-resource")
            effective = fixed_profile["effectiveConfig"]
            for key, expected in fixed_invariants.items():
                require(
                    effective.get(key) == expected,
                    f"{candidate_id}: fixed-resource invariant {key} drifted",
                )
            _validate_profile(profiles["recommended"], candidate_id, "recommended")
        else:
            require(
                candidate_id
                == "native-funasr-1.3.22-paraformer-vad-punctuation"
                and candidate["role"] == "cross_runtime_control"
                and lane_ids == []
                and set(profiles) == {"recommended"}
                and profiles["recommended"]["allowedStages"] == ["STAGE_1_SHORT"],
                "cross-runtime control must remain short-stage and outside sherpa lanes",
            )
            _validate_profile(profiles["recommended"], candidate_id, "recommended")
        if candidate_id == baseline_id:
            require(candidate["role"] == "baseline", "baseline role mismatch")


def _validate_profile(profile: dict[str, Any], candidate_id: str, name: str) -> None:
    exact_fields(
        profile,
        {
            "profileRevision",
            "configurationSource",
            "allowedStages",
            "scorecard",
            "effectiveConfig",
            "notApplicableControls",
        },
        f"{candidate_id}.{name}",
    )
    source = profile["configurationSource"]
    exact_fields(source, {"url", "retrievedAt"}, f"{candidate_id}.{name}.source")
    require(source["url"].startswith("https://"), f"{candidate_id}: profile source")
    require(
        isinstance(profile["effectiveConfig"], dict)
        and profile["effectiveConfig"],
        f"{candidate_id}.{name}: effective config",
    )
    require(
        profile["scorecard"] in {"core_asr", "end_to_end"},
        f"{candidate_id}.{name}: scorecard",
    )
    require(
        isinstance(profile["allowedStages"], list)
        and set(profile["allowedStages"]) <= STAGES,
        f"{candidate_id}.{name}: allowed stages",
    )
    require(
        isinstance(profile["notApplicableControls"], list),
        f"{candidate_id}.{name}: not-applicable controls",
    )


def validate_bundle(
    contract: dict[str, Any],
    candidates: dict[str, Any],
    scoring: dict[str, Any],
) -> None:
    validate_contract(contract)
    validate_candidate_registry(candidates, contract)
    validate_scoring(scoring, contract)


def validate_runtime_characterization(
    characterization: dict[str, Any], contract: dict[str, Any]
) -> None:
    exact_fields(
        characterization,
        {
            "schemaVersion",
            "laneId",
            "resolvedDependency",
            "apiSources",
            "macosRuntime",
            "familySupport",
            "characterizationTest",
            "outcome",
            "runtimeUpgradeRequired",
            "baselineRerunRequiredOnAnyFutureUpgrade",
            "limitations",
        },
        "runtime characterization",
    )
    require(characterization["schemaVersion"] == 2, "runtime characterization schema")
    lanes = {
        lane["laneId"]: lane for lane in contract["runtimeLanes"]
    }
    lane = lanes.get(characterization["laneId"])
    require(lane is not None, "runtime characterization lane is unknown")
    dependency = characterization["resolvedDependency"]
    exact_fields(
        dependency,
        {"package", "version", "pubLockPackageSha256", "workspaceLockSha256"},
        "resolvedDependency",
    )
    require(
        dependency["package"] == lane["runtime"]["package"]
        and dependency["version"] == lane["runtime"]["version"]
        and is_hex64(dependency["pubLockPackageSha256"])
        and is_hex64(dependency["workspaceLockSha256"]),
        "runtime characterization dependency mismatch",
    )
    runtime = characterization["macosRuntime"]
    exact_fields(
        runtime,
        {
            "cApiSha256",
            "cxxApiSha256",
            "onnxRuntimeSha256",
            "binaryArchitectures",
        },
        "characterized macos runtime",
    )
    require(
        runtime["cApiSha256"] == lane["runtime"]["buildSha256"]
        and all(
            is_hex64(runtime[key])
            for key in ("cApiSha256", "cxxApiSha256", "onnxRuntimeSha256")
        )
        and set(runtime["binaryArchitectures"]) == {"arm64", "x86_64"},
        "characterized runtime hashes/architectures mismatch",
    )
    require(
        set(characterization["familySupport"])
        == {
            "streaming_transducer",
            "offline_paraformer",
            "funasr_nano",
            "firered_asr_ctc",
        }
        and all(
            entry.get("state") == "SUPPORTED"
            and isinstance(entry.get("dartTypes"), list)
            and entry["dartTypes"]
            for entry in characterization["familySupport"].values()
        ),
        "runtime family API support is incomplete",
    )
    require(
        characterization["outcome"] == "SUPPORTED"
        and characterization["runtimeUpgradeRequired"] is False
        and characterization["baselineRerunRequiredOnAnyFutureUpgrade"] is True,
        "runtime lane characterization outcome mismatch",
    )


def _parse_time(value: str, location: str) -> datetime:
    require(isinstance(value, str), f"{location} must be a timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractError(f"{location} is not ISO-8601") from error


def validate_round_state(
    state: dict[str, Any],
    contract: dict[str, Any],
    registry: dict[str, Any],
) -> None:
    """Validate stage/disposition invariants before U6 evidence schemas exist."""
    exact_fields(
        state,
        {
            "schemaVersion",
            "contractId",
            "profileFrozenAt",
            "heldOutInspectionStartedAt",
            "materialBenefitFrozen",
            "candidateStates",
            "roundOutcome",
        },
        "round state",
    )
    require(
        state["schemaVersion"] == 2
        and state["contractId"] == contract["contractId"],
        "round state contract mismatch",
    )
    frozen_at = _parse_time(state["profileFrozenAt"], "profileFrozenAt")
    inspected_at_value = state["heldOutInspectionStartedAt"]
    if inspected_at_value is not None:
        inspected_at = _parse_time(
            inspected_at_value, "heldOutInspectionStartedAt"
        )
        require(
            frozen_at < inspected_at,
            "profiles must be frozen before held-out inspection",
        )
        require(
            state["materialBenefitFrozen"] is True,
            "material benefit must be frozen before held-out inspection",
        )
    known = {candidate["candidateId"] for candidate in registry["candidates"]}
    states = state["candidateStates"]
    require(isinstance(states, list) and states, "candidateStates must be non-empty")
    seen: set[str] = set()
    any_material_benefit = False
    for candidate_state in states:
        exact_fields(
            candidate_state,
            {
                "candidateId",
                "stage",
                "terminalDisposition",
                "hardGateResults",
                "materialBenefit",
                "paretoEligible",
            },
            "candidate state",
        )
        candidate_id = candidate_state["candidateId"]
        require(
            candidate_id in known and candidate_id not in seen,
            "candidate state identity mismatch",
        )
        seen.add(candidate_id)
        require(candidate_state["stage"] in STAGES, "candidate stage invalid")
        disposition = candidate_state["terminalDisposition"]
        require(
            disposition is None or disposition in TERMINAL_DISPOSITIONS,
            "terminal disposition invalid",
        )
        gates = candidate_state["hardGateResults"]
        exact_fields(
            gates,
            {"cer", "rtf", "incrementalPeakRssBytes"},
            "hardGateResults",
        )
        require(
            set(gates.values()) <= {"PASS", "FAIL", "NOT_APPLICABLE", "PENDING"},
            "hard gate result invalid",
        )
        hard_failure = "FAIL" in gates.values()
        require(
            not (hard_failure and candidate_state["paretoEligible"]),
            "candidate with a hard gate failure cannot enter Pareto review",
        )
        require(
            not candidate_state["paretoEligible"]
            or candidate_state["materialBenefit"] is True,
            "Pareto review requires material benefit",
        )
        any_material_benefit |= candidate_state["materialBenefit"] is True
    require(
        state["roundOutcome"] in contract["roundOutcomes"],
        "unknown round outcome",
    )
    if not any_material_benefit:
        require(
            state["roundOutcome"] == "RETAIN_BASELINE_NO_MATERIAL_BENEFIT",
            "no material benefit requires retain baseline outcome",
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parent
    parser.add_argument("--contract", type=Path, default=root / "macos_contract.json")
    parser.add_argument("--candidates", type=Path, default=root / "candidates.json")
    parser.add_argument(
        "--scoring", type=Path, default=root / "scoring_contract.json"
    )
    parser.add_argument(
        "--runtime-characterization",
        type=Path,
        default=root / "runtime_lane_characterization.json",
    )
    parser.add_argument("--round-state", type=Path)
    parser.add_argument("--print-hashes", action="store_true")
    args = parser.parse_args()
    try:
        contract = load_object(args.contract)
        candidates = load_object(args.candidates)
        scoring = load_object(args.scoring)
        validate_bundle(contract, candidates, scoring)
        if args.runtime_characterization.is_file():
            validate_runtime_characterization(
                load_object(args.runtime_characterization), contract
            )
        if args.round_state is not None:
            validate_round_state(
                load_object(args.round_state), contract, candidates
            )
    except (OSError, json.JSONDecodeError, ContractError) as error:
        print(f"macOS ASR comparison contract: FAIL: {error}")
        return 1
    print("macOS ASR comparison contract: PASS")
    if args.print_hashes:
        for path in (args.contract, args.candidates, args.scoring):
            print(f"{path.name} {sha256(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
