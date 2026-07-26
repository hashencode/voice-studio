#!/usr/bin/env python3
"""Seal a completed M4 development matrix before held-out decoding."""

from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from aggregate_results import (
    AggregationError,
    aggregate_candidate,
    compare_to_baseline,
)
from prepare_fixtures import (
    FixtureError,
    safe_relative,
    sha256_bytes,
    sha256_file,
    validate_manifest,
)
from validate_contract import (
    ContractError,
    validate_bundle,
)


RESULT_FIELDS = {
    "schemaVersion",
    "kind",
    "complete",
    "rankEligible",
    "heldOutDecoded",
    "targetFingerprint",
    "contractSha256",
    "candidateRegistrySha256",
    "fixtureManifestSha256",
    "scoringContractSha256",
    "scorerSha256",
    "workerSha256",
    "scheduledRunCount",
    "completedRunCount",
    "warmupRunCount",
    "measuredRunCount",
    "aggregatePaths",
    "comparisons",
    "materialityState",
    "developmentFreezeReady",
}
FREEZE_FIELDS = {
    "schemaVersion",
    "kind",
    "complete",
    "rankEligible",
    "heldOutAuthorized",
    "heldOutDecoded",
    "frozenAt",
    "contractId",
    "contractState",
    "targetFingerprint",
    "bindings",
    "fixtureManifestId",
    "developmentFixtureIds",
    "admittedCandidateIds",
    "excludedCandidateDispositions",
    "schedule",
    "profilesSha256",
    "materialBenefitRule",
    "aggregateSha256",
    "comparisons",
    "privacy",
}
HEX = set("0123456789abcdef")


class DevelopmentFreezeError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DevelopmentFreezeError(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in HEX for character in value)
    )


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise DevelopmentFreezeError(f"{label} is unavailable") from error
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def _validate_frozen_at(value: str) -> None:
    require(
        isinstance(value, str) and value.endswith("Z"),
        "frozenAt must be an explicit UTC timestamp",
    )
    try:
        datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise DevelopmentFreezeError(
            "frozenAt must be an explicit UTC timestamp"
        ) from error


def _finite(value: Any, label: str) -> None:
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{label} must be finite",
    )


def _validate_target(
    target: dict[str, Any],
    contract: dict[str, Any],
) -> None:
    required = set(
        contract["target"]["targetFingerprintRequiredFields"]
    )
    require(set(target) == required, "target fingerprint fields mismatch")
    require(
        target["cpuModel"] == "Apple M4"
        and target["architecture"] == "arm64"
        and target["memoryBytes"]
        == contract["target"]["referenceMemoryBytes"],
        "development freeze target must be the frozen Apple M4",
    )
    lane = contract["runtimeLanes"][0]
    require(
        target["runtimeId"] == lane["laneId"]
        and target["runtimeVersion"] == lane["runtime"]["version"]
        and _is_sha256(target["runtimeSha256"]),
        "development freeze runtime identity mismatch",
    )
    require(
        isinstance(target["operatingSystemVersion"], str)
        and bool(target["operatingSystemVersion"])
        and isinstance(target["logicalCpuCount"], int)
        and target["logicalCpuCount"] > 0,
        "development freeze target details are invalid",
    )


def _validate_aggregate(
    aggregate: dict[str, Any],
    *,
    candidate: dict[str, Any],
    profile_id: str,
    fixtures: list[dict[str, Any]],
    measured_runs_per_fixture: int,
    total_runs_per_fixture: int,
) -> None:
    fixture_ids = {fixture["fixtureId"] for fixture in fixtures}
    scenarios = {fixture["scenario"] for fixture in fixtures}
    require(
        aggregate.get("schemaVersion") == 2
        and aggregate.get("candidateId") == candidate["candidateId"]
        and aggregate.get("laneId") == candidate["runtimeLaneIds"][0]
        and aggregate.get("profileId") == profile_id
        and aggregate.get("scorecard")
        == candidate["profiles"][profile_id]["scorecard"],
        "development aggregate identity mismatch",
    )
    runs = aggregate.get("runs")
    require(
        isinstance(runs, list)
        and len(runs) == len(fixtures) * total_runs_per_fixture,
        "development aggregate run count mismatch",
    )
    measured = [run for run in runs if run.get("warmup") is False]
    require(
        len(measured) == len(fixtures) * measured_runs_per_fixture
        and aggregate.get("measuredRunCount") == len(measured),
        "development aggregate measured run count mismatch",
    )
    require(
        {run.get("fixtureId") for run in runs} == fixture_ids
        and {run.get("scenario") for run in runs} == scenarios,
        "development aggregate fixture coverage mismatch",
    )
    require(
        all(
            run.get("candidateId", candidate["candidateId"])
            == candidate["candidateId"]
            and run.get("warmup") in {True, False}
            and _is_sha256(run.get("rawOutputSha256"))
            for run in runs
        ),
        "development aggregate run binding mismatch",
    )
    require(
        set(aggregate.get("scenarioMetrics", {})) == scenarios,
        "development aggregate scenario metrics mismatch",
    )
    macro = aggregate.get("macroMetrics")
    require(
        isinstance(macro, dict) and macro.get("cer") is not None,
        "development aggregate macro CER is missing",
    )
    _finite(macro["cer"], "development aggregate macro CER")
    require(
        aggregate.get("determinism", {}).get("stable") is True,
        "development aggregate output is not deterministic",
    )
    require(
        aggregate.get("aggregationPolicy")
        == {
            "warmupsExcluded": True,
            "scenarioMacroEqualWeight": True,
            "durationWeighted": False,
        },
        "development aggregate policy mismatch",
    )
    try:
        recomputed = aggregate_candidate(
            [
                {
                    **run,
                    "candidateId": candidate["candidateId"],
                    "laneId": candidate["runtimeLaneIds"][0],
                    "profileId": profile_id,
                    "scorecard": candidate["profiles"][profile_id][
                        "scorecard"
                    ],
                }
                for run in runs
            ]
        )
    except AggregationError as error:
        raise DevelopmentFreezeError(str(error)) from error
    require(
        canonical_json(recomputed) == canonical_json(aggregate),
        "development aggregate drift",
    )


def _reject_private_values(value: Any, location: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            if key in {
                "rawAudioPublished",
                "transcriptsPublished",
                "speakerIdentityPublished",
                "absolutePathsPublished",
            }:
                require(
                    child is False,
                    f"{location}: privacy publication must remain false",
                )
                continue
            require(
                not any(
                    forbidden in lowered
                    for forbidden in (
                        "transcript",
                        "audio",
                        "pcm",
                        "speakeridentity",
                        "absolutepath",
                    )
                ),
                f"{location}: forbidden private field {key}",
            )
            _reject_private_values(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_private_values(child, f"{location}[{index}]")
    elif isinstance(value, str):
        require(
            not value.startswith("/")
            and not value.startswith("~")
            and "/Users/" not in value
            and "\\Users\\" not in value,
            f"{location}: absolute or user-home value is forbidden",
        )


def build_development_freeze(
    root: Path,
    matrix_root: Path,
    *,
    frozen_at: str,
) -> dict[str, Any]:
    _validate_frozen_at(frozen_at)
    comparison = root / "benchmark/desktop/asr_comparison"
    contract_path = comparison / "macos_contract.json"
    registry_path = comparison / "candidates.json"
    fixtures_path = comparison / "fixtures.json"
    scoring_path = comparison / "scoring_contract.json"
    scorer_path = comparison / "asr_scoring.py"
    contract = _load_json(contract_path, "comparison contract")
    registry = _load_json(registry_path, "candidate registry")
    fixtures_manifest = _load_json(fixtures_path, "fixture manifest")
    scoring = _load_json(scoring_path, "scoring contract")
    try:
        validate_bundle(contract, registry, scoring)
        validate_manifest(
            fixtures_manifest,
            ranked=False,
            development=True,
        )
    except (ContractError, FixtureError) as error:
        raise DevelopmentFreezeError(str(error)) from error
    require(
        contract["contractState"]
        == "M4_DEVELOPMENT_FROZEN_HELD_OUT_SEALED"
        and contract["materialBenefitRule"]["state"] == "FROZEN",
        "development contract is not sealed",
    )
    result_path = matrix_root / "development-matrix-result.json"
    result = _load_json(result_path, "development matrix result")
    require(
        set(result) == RESULT_FIELDS
        and result["schemaVersion"] == 2
        and result["kind"] == "development_matrix_result",
        "development matrix result fields mismatch",
    )
    require(
        result["complete"] is True
        and result["developmentFreezeReady"] is True,
        "development matrix is incomplete",
    )
    require(
        result["heldOutDecoded"] is False,
        "held-out data was decoded before development freeze",
    )
    require(
        result["rankEligible"] is False,
        "development matrix cannot be held-out ranking evidence",
    )
    require(
        result["materialityState"] == "FROZEN",
        "development matrix did not use the frozen materiality rule",
    )
    bindings = {
        "contractSha256": sha256_file(contract_path),
        "candidateRegistrySha256": sha256_file(registry_path),
        "fixtureManifestSha256": sha256_file(fixtures_path),
        "scoringContractSha256": sha256_file(scoring_path),
        "scorerSha256": sha256_file(scorer_path),
        "workerSha256": result["workerSha256"],
        "matrixResultSha256": sha256_file(result_path),
    }
    for key in (
        "contractSha256",
        "candidateRegistrySha256",
        "fixtureManifestSha256",
        "scoringContractSha256",
        "scorerSha256",
        "workerSha256",
    ):
        require(
            result[key] == bindings[key] and _is_sha256(bindings[key]),
            f"development matrix {key} drift",
        )
    _validate_target(result["targetFingerprint"], contract)

    development_fixtures = [
        fixture
        for fixture in fixtures_manifest["fixtures"]
        if fixture["fixtureRole"] == "development"
    ]
    admitted = [
        candidate
        for candidate in registry["candidates"]
        if candidate["runtimeKind"] == "sherpa_onnx"
        and candidate["admission"]["status"] == "ADMITTED"
    ]
    profiles = contract["profiles"]["requiredSherpaProfiles"]
    warmups = contract["scheduling"]["shortWarmupRuns"]
    measured = contract["scheduling"]["shortMeasuredRuns"]
    expected_aggregate_keys = {
        f"{candidate['candidateId']}/{profile_id}"
        for candidate in admitted
        for profile_id in profiles
    }
    expected_comparison_keys = {
        f"{candidate['candidateId']}/{profile_id}"
        for candidate in admitted
        if candidate["candidateId"] != contract["baselineCandidateId"]
        for profile_id in profiles
    }
    expected_cells = (
        len(admitted) * len(profiles) * len(development_fixtures)
    )
    require(
        result["scheduledRunCount"]
        == result["completedRunCount"]
        == expected_cells * (warmups + measured)
        and result["warmupRunCount"] == expected_cells * warmups
        and result["measuredRunCount"] == expected_cells * measured,
        "development matrix schedule counts mismatch",
    )
    require(
        set(result["aggregatePaths"]) == expected_aggregate_keys
        and set(result["comparisons"]) == expected_comparison_keys,
        "development matrix aggregate/comparison set mismatch",
    )
    candidate_index = {
        candidate["candidateId"]: candidate
        for candidate in registry["candidates"]
    }
    aggregates: dict[str, dict[str, Any]] = {}
    aggregate_hashes: dict[str, str] = {}
    for key in sorted(expected_aggregate_keys):
        relative = safe_relative(
            result["aggregatePaths"][key],
            f"aggregatePaths.{key}",
        )
        path = root / relative
        require(
            path.is_file()
            and path.resolve().is_relative_to(matrix_root.resolve()),
            f"{key}: aggregate path escapes the development matrix",
        )
        aggregate = _load_json(path, f"{key} aggregate")
        candidate_id, profile_id = key.split("/", maxsplit=1)
        _validate_aggregate(
            aggregate,
            candidate=candidate_index[candidate_id],
            profile_id=profile_id,
            fixtures=development_fixtures,
            measured_runs_per_fixture=measured,
            total_runs_per_fixture=warmups + measured,
        )
        aggregates[key] = aggregate
        aggregate_hashes[key] = sha256_file(path)

    recomputed_comparisons: dict[str, dict[str, Any]] = {}
    baseline_id = contract["baselineCandidateId"]
    try:
        for key in sorted(expected_comparison_keys):
            candidate_id, profile_id = key.split("/", maxsplit=1)
            recomputed_comparisons[key] = compare_to_baseline(
                aggregates[key],
                aggregates[f"{baseline_id}/{profile_id}"],
                hard_gates=contract["hardGates"],
                materiality=contract["materialBenefitRule"],
            )
    except AggregationError as error:
        raise DevelopmentFreezeError(str(error)) from error
    require(
        canonical_json(recomputed_comparisons)
        == canonical_json(result["comparisons"]),
        "development comparison drift",
    )
    profiles_binding = {
        candidate["candidateId"]: {
            profile_id: candidate["profiles"][profile_id]
            for profile_id in profiles
        }
        for candidate in admitted
    }
    excluded = [
        {
            "candidateId": candidate["candidateId"],
            "status": candidate["admission"]["status"],
            "terminalDisposition": candidate["admission"].get(
                "terminalDisposition"
            ),
        }
        for candidate in registry["candidates"]
        if candidate not in admitted
    ]
    freeze = {
        "schemaVersion": 2,
        "kind": "development_freeze",
        "complete": True,
        "rankEligible": False,
        "heldOutAuthorized": True,
        "heldOutDecoded": False,
        "frozenAt": frozen_at,
        "contractId": contract["contractId"],
        "contractState": contract["contractState"],
        "targetFingerprint": result["targetFingerprint"],
        "bindings": bindings,
        "fixtureManifestId": fixtures_manifest["fixtureManifestId"],
        "developmentFixtureIds": sorted(
            fixture["fixtureId"] for fixture in development_fixtures
        ),
        "admittedCandidateIds": sorted(
            candidate["candidateId"] for candidate in admitted
        ),
        "excludedCandidateDispositions": sorted(
            excluded,
            key=lambda value: value["candidateId"],
        ),
        "schedule": {
            "seed": contract["scheduling"]["seed"],
            "warmupRunsPerCell": warmups,
            "measuredRunsPerCell": measured,
            "scheduledRunCount": result["scheduledRunCount"],
            "completedRunCount": result["completedRunCount"],
        },
        "profilesSha256": sha256_bytes(
            canonical_json(profiles_binding)
        ),
        "materialBenefitRule": contract["materialBenefitRule"],
        "aggregateSha256": aggregate_hashes,
        "comparisons": recomputed_comparisons,
        "privacy": {
            "rawAudioPublished": False,
            "transcriptsPublished": False,
            "speakerIdentityPublished": False,
            "absolutePathsPublished": False,
        },
    }
    _reject_private_values(freeze)
    return freeze


def validate_development_freeze(
    freeze: dict[str, Any],
    root: Path,
    matrix_root: Path,
) -> dict[str, Any]:
    require(
        isinstance(freeze, dict)
        and set(freeze) == FREEZE_FIELDS
        and freeze["schemaVersion"] == 2
        and freeze["kind"] == "development_freeze",
        "development freeze fields mismatch",
    )
    expected = build_development_freeze(
        root,
        matrix_root,
        frozen_at=freeze["frozenAt"],
    )
    require(
        canonical_json(freeze) == canonical_json(expected),
        "development freeze sealed-transition drift",
    )
    return freeze


def publish_development_freeze(
    root: Path,
    matrix_root: Path,
    output: Path,
    *,
    frozen_at: str,
) -> dict[str, Any]:
    freeze = build_development_freeze(
        root,
        matrix_root,
        frozen_at=frozen_at,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.",
        suffix=".temporary",
        dir=output.parent,
    )
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(
                freeze,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        validate_development_freeze(
            json.loads(temporary.read_text()),
            root,
            matrix_root,
        )
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return freeze


def main() -> int:
    comparison = Path(__file__).resolve().parent
    root = comparison.parents[2]
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--publish", action="store_true")
    parser.add_argument("--frozen-at", required=True)
    parser.add_argument(
        "--matrix-root",
        type=Path,
        default=root / "build/desktop_asr_comparison/development/m4",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            root
            / "benchmark/desktop/evidence/macos-asr-comparison-v2/"
            "development-freeze.json"
        ),
    )
    args = parser.parse_args()
    matrix_root = args.matrix_root.resolve()
    output = args.output.resolve()
    expected_output = (
        root
        / "benchmark/desktop/evidence/macos-asr-comparison-v2/"
        "development-freeze.json"
    ).resolve()
    try:
        require(
            matrix_root.is_relative_to(
                (root / "build/desktop_asr_comparison").resolve()
            ),
            "development matrix must stay under the ignored build root",
        )
        require(
            output == expected_output,
            "development freeze output path is fixed",
        )
        if args.publish:
            freeze = publish_development_freeze(
                root,
                matrix_root,
                output,
                frozen_at=args.frozen_at,
            )
        else:
            freeze = build_development_freeze(
                root,
                matrix_root,
                frozen_at=args.frozen_at,
            )
    except (
        OSError,
        json.JSONDecodeError,
        DevelopmentFreezeError,
    ) as error:
        print(f"development freeze: FAIL: {error}")
        return 1
    print(
        "development freeze: PASS "
        f"heldOutAuthorized={freeze['heldOutAuthorized']} "
        f"aggregates={len(freeze['aggregateSha256'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
