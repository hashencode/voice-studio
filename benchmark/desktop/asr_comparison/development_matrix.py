#!/usr/bin/env python3
"""Execute the frozen macOS ASR development matrix without publishing raw data."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from aggregate_results import (
    AggregationError,
    aggregate_candidate,
    compare_to_baseline,
)
from prepare_fixtures import FixtureError, safe_relative, validate_manifest
from run_macos_asr_comparison import (
    OrchestrationError,
    _atomic_json,
    canonical_json,
    deterministic_schedule,
    execute_run,
    sha256_bytes,
    sha256_file,
)
from validate_contract import ContractError, validate_bundle


class DevelopmentMatrixError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DevelopmentMatrixError(message)


def required_model_roles(family: str) -> tuple[str, ...]:
    roles = {
        "streaming_zipformer_transducer": (
            "decoder",
            "encoder",
            "joiner",
            "tokens",
        ),
        "offline_paraformer": ("model", "tokens"),
        "firered_asr_ctc": ("model", "tokens"),
    }
    require(family in roles, f"unsupported family for development matrix: {family}")
    return roles[family]


def validate_prepared_fixture_pack(
    prepared_root: Path,
    fixture_manifest: dict[str, Any],
) -> dict[str, dict[str, Path]]:
    try:
        prepared = json.loads(
            (prepared_root / "prepared_manifest.json").read_text()
        )
    except (OSError, json.JSONDecodeError) as error:
        raise DevelopmentMatrixError(
            "prepared development fixture manifest is unavailable"
        ) from error
    require(
        set(prepared)
        == {
            "schemaVersion",
            "fixtureManifestId",
            "mode",
            "fixtureCount",
            "files",
            "fileSha256",
        },
        "prepared development fixture fields mismatch",
    )
    require(
        prepared["schemaVersion"] == 2
        and prepared["fixtureManifestId"] == fixture_manifest["fixtureManifestId"]
        and prepared["mode"] == "development",
        "prepared development fixture identity mismatch",
    )
    development = [
        fixture
        for fixture in fixture_manifest["fixtures"]
        if fixture["fixtureRole"] == "development"
    ]
    require(
        prepared["fixtureCount"] == len(development),
        "prepared development fixture count mismatch",
    )
    expected_files: set[str] = set()
    resolved: dict[str, dict[str, Path]] = {}
    hashes = prepared["fileSha256"]
    require(
        isinstance(prepared["files"], list) and isinstance(hashes, dict),
        "prepared development fixture file index is invalid",
    )
    for fixture in development:
        fixture_id = fixture["fixtureId"]
        audio_relative = (
            f"fixtures/{fixture_id}{Path(fixture['audio']['relativePath']).suffix}"
        )
        reference_relative = f"fixtures/{fixture_id}.txt"
        expected_files.update((audio_relative, reference_relative))
        audio = prepared_root / audio_relative
        reference = prepared_root / reference_relative
        for path, relative, metadata in (
            (audio, audio_relative, fixture["audio"]),
            (reference, reference_relative, fixture["reference"]),
        ):
            require(
                path.is_file()
                and path.resolve().is_relative_to(prepared_root.resolve()),
                f"{fixture_id}: prepared file is missing or escapes",
            )
            digest = sha256_file(path)
            require(
                digest == metadata["sha256"] and digest == hashes.get(relative),
                f"{fixture_id}: prepared file hash mismatch",
            )
            require(
                path.stat().st_size == metadata["bytes"],
                f"{fixture_id}: prepared file size mismatch",
            )
        try:
            reference.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise DevelopmentMatrixError(
                f"{fixture_id}: reference is not UTF-8"
            ) from error
        resolved[fixture_id] = {"audio": audio, "reference": reference}
    require(
        set(prepared["files"]) == expected_files
        and set(hashes) == expected_files,
        "prepared development fixture set contains missing or extra files",
    )
    return resolved


def validate_candidate_assets(
    assets_root: Path,
    candidate: dict[str, Any],
) -> dict[str, Path]:
    candidate_id = candidate["candidateId"]
    require(
        candidate["runtimeKind"] == "sherpa_onnx"
        and candidate["admission"]["status"] == "ADMITTED",
        f"{candidate_id}: candidate is not admitted for development",
    )
    active = assets_root / candidate_id / "active"
    try:
        manifest = json.loads((active / "asset_manifest.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise DevelopmentMatrixError(
            f"{candidate_id}: prepared asset manifest is unavailable"
        ) from error
    require(
        manifest.get("schemaVersion") == 2
        and manifest.get("candidateId") == candidate_id
        and manifest.get("licenseDisposition") == "ACCEPTED_FOR_BENCHMARK"
        and manifest.get("sourcePathsPublished") is False,
        f"{candidate_id}: prepared asset identity mismatch",
    )
    components = manifest.get("components")
    file_hashes = manifest.get("fileSha256")
    require(
        isinstance(components, list) and isinstance(file_hashes, dict),
        f"{candidate_id}: prepared asset index is invalid",
    )
    require(
        manifest.get("fileCount") == len(components) == len(file_hashes),
        f"{candidate_id}: prepared asset count mismatch",
    )
    for relative, expected in file_hashes.items():
        path = active / safe_relative(
            relative,
            f"{candidate_id}.preparedAsset",
        )
        require(
            path.is_file()
            and path.resolve().is_relative_to(active.resolve())
            and sha256_file(path) == expected,
            f"{candidate_id}: prepared asset hash mismatch",
        )
    component_index = {
        component.get("componentId"): component
        for component in components
        if isinstance(component, dict)
    }
    require(
        len(component_index) == len(components),
        f"{candidate_id}: prepared asset components are duplicated",
    )
    identity = "\n".join(
        f"{component['componentId']}\0{component['bytes']}\0{component['sha256']}"
        for component in sorted(
            components,
            key=lambda value: value["componentId"],
        )
    ).encode()
    require(
        manifest.get("extractedTreeSha256") == sha256_bytes(identity),
        f"{candidate_id}: prepared asset tree hash mismatch",
    )
    artifact_index = {
        artifact["componentId"]: artifact for artifact in candidate["artifacts"]
    }
    model_files: dict[str, Path] = {}
    for role in required_model_roles(candidate["family"]):
        artifact = artifact_index.get(role)
        component = component_index.get(role)
        require(
            isinstance(artifact, dict) and isinstance(component, dict),
            f"{candidate_id}: required model role is missing: {role}",
        )
        path = active / "files" / role
        require(
            path.is_file()
            and path.resolve().is_relative_to(active.resolve()),
            f"{candidate_id}: prepared model path is missing or escapes",
        )
        digest = sha256_file(path)
        require(
            digest == artifact["sha256"]
            and digest == component.get("sha256")
            and digest == file_hashes.get(f"files/{role}"),
            f"{candidate_id}/{role}: prepared model hash mismatch",
        )
        require(
            path.stat().st_size == component.get("bytes"),
            f"{candidate_id}/{role}: prepared model size mismatch",
        )
        model_files[role] = path
    return model_files


def build_development_schedule(
    contract: dict[str, Any],
    registry: dict[str, Any],
    fixture_manifest: dict[str, Any],
    scoring_contract: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    try:
        if scoring_contract is None:
            scoring_contract = json.loads(
                (
                    Path(__file__).resolve().parent / "scoring_contract.json"
                ).read_text()
            )
        validate_bundle(
            contract,
            registry,
            scoring_contract,
        )
        validate_manifest(fixture_manifest, ranked=False, development=True)
    except (ContractError, FixtureError, OSError, json.JSONDecodeError) as error:
        raise DevelopmentMatrixError(str(error)) from error
    require(
        contract["target"]["referenceCpuModel"] == "Apple M4",
        "development matrix target must remain Apple M4",
    )
    fixtures = [
        fixture
        for fixture in fixture_manifest["fixtures"]
        if fixture["fixtureRole"] == "development"
    ]
    require(fixtures, "development fixture set is empty")
    candidates = [
        candidate
        for candidate in registry["candidates"]
        if candidate["runtimeKind"] == "sherpa_onnx"
        and candidate["admission"]["status"] == "ADMITTED"
    ]
    require(
        any(
            candidate["candidateId"] == contract["baselineCandidateId"]
            for candidate in candidates
        ),
        "admitted same-lane baseline is missing",
    )
    matrix: list[dict[str, Any]] = []
    for candidate in candidates:
        required_model_roles(candidate["family"])
        lane_ids = candidate["runtimeLaneIds"]
        require(
            isinstance(lane_ids, list) and len(lane_ids) == 1,
            f"{candidate['candidateId']}: development lane must resolve exactly once",
        )
        for profile_id in contract["profiles"]["requiredSherpaProfiles"]:
            profile = candidate["profiles"].get(profile_id)
            require(
                isinstance(profile, dict)
                and "STAGE_1_SHORT" in profile["allowedStages"],
                (
                    f"{candidate['candidateId']}/{profile_id}: "
                    "profile is not allowed in Stage 1"
                ),
            )
            for fixture in fixtures:
                matrix.append(
                    {
                        "candidateId": candidate["candidateId"],
                        "family": candidate["family"],
                        "laneId": lane_ids[0],
                        "profileId": profile_id,
                        "fixtureId": fixture["fixtureId"],
                        "scenario": fixture["scenario"],
                        "scorecard": profile["scorecard"],
                        "rankEligible": True,
                        "observationSource": "m4_development_matrix",
                        "pacingPolicy": profile["effectiveConfig"].get(
                            "pacingPolicy",
                            "unpaced",
                        ),
                    }
                )
    try:
        return deterministic_schedule(
            matrix,
            seed=int(contract["scheduling"]["seed"]),
            warmup_runs=int(contract["scheduling"]["shortWarmupRuns"]),
            measured_runs=int(contract["scheduling"]["shortMeasuredRuns"]),
        )
    except OrchestrationError as error:
        raise DevelopmentMatrixError(str(error)) from error


def validate_runtime_inputs(
    tools_root: Path,
    runtime_root: Path,
) -> dict[str, Path]:
    paths = {
        "launcher": tools_root / "sandboxed_candidate_launcher",
        "worker": tools_root / "desktop_asr_candidate_worker",
        "processGroupLauncher": tools_root / "native_process_group_launcher",
        "runtime": runtime_root / "libsherpa-onnx-c-api.dylib",
    }
    for name, path in paths.items():
        require(path.is_file(), f"{name} input is missing")
    for name in ("launcher", "worker", "processGroupLauncher"):
        require(os.access(paths[name], os.X_OK), f"{name} is not executable")
    require(
        len({tools_root.resolve(), runtime_root.resolve()}) == 2,
        "tool and runtime roots must be distinct",
    )
    return paths


def validate_runtime_identity(
    root: Path,
    loaded_runtime: Path,
    expected_package_sha256: str,
) -> str:
    try:
        package_config = json.loads(
            (root / ".dart_tool/package_config.json").read_text()
        )
    except (OSError, json.JSONDecodeError) as error:
        raise DevelopmentMatrixError(
            "Dart package configuration is unavailable"
        ) from error
    matches = [
        package
        for package in package_config.get("packages", [])
        if package.get("name") == "sherpa_onnx_macos"
    ]
    require(
        len(matches) == 1,
        "sherpa_onnx_macos package must resolve exactly once",
    )
    parsed = urlparse(matches[0].get("rootUri", ""))
    require(
        parsed.scheme == "file" and bool(parsed.path),
        "sherpa_onnx_macos package root is not a file URI",
    )
    package_runtime = (
        Path(unquote(parsed.path)) / "macos/libsherpa-onnx-c-api.dylib"
    )
    require(
        package_runtime.is_file()
        and sha256_file(package_runtime) == expected_package_sha256,
        "sherpa runtime package payload hash mismatch",
    )
    loaded_sha256 = sha256_file(loaded_runtime)
    if loaded_sha256 == expected_package_sha256:
        return loaded_sha256
    require(
        platform.system() == "Darwin",
        "loaded sherpa runtime differs from its package payload",
    )

    def cdhash(path: Path) -> str:
        try:
            output = subprocess.check_output(
                ["/usr/bin/codesign", "-d", "--verbose=4", str(path)],
                text=True,
                stderr=subprocess.STDOUT,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise DevelopmentMatrixError(
                "sherpa runtime code-signature identity is unavailable"
            ) from error
        match = re.search(
            r"CandidateCDHashFull sha256=([0-9a-f]{64})",
            output,
        )
        require(match is not None, "sherpa runtime CDHash is missing")
        return match.group(1)

    try:
        with tempfile.TemporaryDirectory(prefix="asr-runtime-identity-") as temporary:
            normalized = (
                Path(temporary) / "libsherpa-onnx-c-api.dylib"
            )
            shutil.copyfile(package_runtime, normalized)
            subprocess.run(
                [
                    "/usr/bin/codesign",
                    "--force",
                    "--sign",
                    "-",
                    str(normalized),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            require(
                cdhash(normalized) == cdhash(loaded_runtime),
                "loaded sherpa runtime payload differs after signing normalization",
            )
    except subprocess.CalledProcessError as error:
        raise DevelopmentMatrixError(
            "sherpa runtime signing normalization failed"
        ) from error
    return loaded_sha256


def preflight_development_matrix(
    root: Path,
    *,
    fixtures_root: Path,
    assets_root: Path,
    tools_root: Path,
    runtime_root: Path,
    target_fingerprint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    comparison = root / "benchmark/desktop/asr_comparison"
    try:
        contract = json.loads((comparison / "macos_contract.json").read_text())
        registry = json.loads((comparison / "candidates.json").read_text())
        fixture_manifest = json.loads((comparison / "fixtures.json").read_text())
        scoring_contract = json.loads(
            (comparison / "scoring_contract.json").read_text()
        )
    except (OSError, json.JSONDecodeError) as error:
        raise DevelopmentMatrixError(
            "comparison contract bundle is unavailable"
        ) from error
    target = target_fingerprint or current_target_fingerprint()
    validate_target_fingerprint(contract, target)
    schedule = build_development_schedule(
        contract,
        registry,
        fixture_manifest,
        scoring_contract,
    )
    fixtures = validate_prepared_fixture_pack(fixtures_root, fixture_manifest)
    candidate_index = {
        candidate["candidateId"]: candidate for candidate in registry["candidates"]
    }
    admitted_ids = sorted({item["candidateId"] for item in schedule})
    assets = {
        candidate_id: validate_candidate_assets(
            assets_root,
            candidate_index[candidate_id],
        )
        for candidate_id in admitted_ids
    }
    runtime_inputs = validate_runtime_inputs(tools_root, runtime_root)
    lane = contract["runtimeLanes"][0]
    require(
        {
            candidate_index[candidate_id]["runtimeLaneIds"][0]
            for candidate_id in admitted_ids
        }
        == {lane["laneId"]},
        "development candidates do not share one frozen runtime lane",
    )
    target_with_runtime = {
        key: target[key]
        for key in (
            "operatingSystemVersion",
            "architecture",
            "cpuModel",
            "logicalCpuCount",
            "memoryBytes",
        )
    }
    loaded_runtime_sha256 = validate_runtime_identity(
        root,
        runtime_inputs["runtime"],
        lane["runtime"]["buildSha256"],
    )
    target_with_runtime.update(
        {
            "runtimeId": lane["laneId"],
            "runtimeVersion": lane["runtime"]["version"],
            "runtimeSha256": loaded_runtime_sha256,
        }
    )
    required_fields = set(contract["target"]["targetFingerprintRequiredFields"])
    require(
        set(target_with_runtime) == required_fields,
        "target fingerprint fields do not match the frozen contract",
    )
    return {
        "root": root,
        "comparisonRoot": comparison,
        "contract": contract,
        "registry": registry,
        "fixtureManifest": fixture_manifest,
        "scoringContract": scoring_contract,
        "schedule": schedule,
        "fixtures": fixtures,
        "assets": assets,
        "candidateIndex": candidate_index,
        "runtimeInputs": runtime_inputs,
        "toolsRoot": tools_root,
        "runtimeRoot": runtime_root,
        "targetFingerprint": target_with_runtime,
    }


def execute_development_matrix(
    context: dict[str, Any],
    *,
    output_root: Path,
    timeout_seconds: float,
    sampler_interval_seconds: float = 0.02,
    execute: Any = execute_run,
) -> dict[str, Any]:
    require(
        0 < timeout_seconds <= 86_400,
        "development run timeout is invalid",
    )
    root: Path = context["root"]
    comparison: Path = context["comparisonRoot"]
    contract = context["contract"]
    registry = context["registry"]
    candidate_index = context["candidateIndex"]
    common_bindings = {
        "contractSha256": sha256_file(comparison / "macos_contract.json"),
        "candidateRegistrySha256": sha256_file(comparison / "candidates.json"),
        "scoringContractSha256": sha256_file(
            comparison / "scoring_contract.json"
        ),
        "scorerSha256": sha256_file(comparison / "asr_scoring.py"),
        "runtimeSha256": context["targetFingerprint"]["runtimeSha256"],
        "workerSha256": sha256_file(context["runtimeInputs"]["worker"]),
    }
    run_root = output_root / "runs"
    raw_root = output_root / "raw"
    jobs_root = output_root / "jobs"
    aggregates_root = output_root / "aggregates"
    runs: list[dict[str, Any]] = []
    for scheduled in context["schedule"]:
        candidate = candidate_index[scheduled["candidateId"]]
        fixture = context["fixtures"][scheduled["fixtureId"]]
        profile = candidate["profiles"][scheduled["profileId"]]
        audio_source = fixture["audio"]
        reference_source = fixture["reference"]
        job_root = jobs_root / (
            f"{scheduled['scheduleOrder']:04d}-{scheduled['candidateId']}"
        )
        if job_root.exists():
            shutil.rmtree(job_root)
        input_root = job_root / "input"
        input_root.mkdir(parents=True)
        audio = input_root / audio_source.name
        shutil.copyfile(audio_source, audio)
        try:
            model_files = {
                role: {
                    "path": str(path),
                    "sha256": sha256_file(path),
                }
                for role, path in context["assets"][
                    scheduled["candidateId"]
                ].items()
            }
            effective_config = profile["effectiveConfig"]
            request = {
                "roots": {
                    "jobRoot": str(job_root),
                    "runtimeRoot": str(context["runtimeRoot"]),
                    "modelRoot": str(
                        context["assets"][scheduled["candidateId"]][
                            next(iter(model_files))
                        ].parents[1]
                    ),
                    "toolRoot": str(context["toolsRoot"]),
                },
                "nativeProcessGroupLauncher": str(
                    context["runtimeInputs"]["processGroupLauncher"]
                ),
                "worker": str(context["runtimeInputs"]["worker"]),
                "workerRequest": {
                    "schemaVersion": 2,
                    "candidateId": scheduled["candidateId"],
                    "family": candidate["family"],
                    "profileId": scheduled["profileId"],
                    "sourcePath": str(audio),
                    "sourceSha256": sha256_file(audio),
                    "modelFiles": model_files,
                    "effectiveConfig": effective_config,
                    "capabilities": candidate["capabilities"],
                    "expectSpeech": scheduled["scenario"] != "non_speech",
                    "settleMilliseconds": 1000,
                },
            }
            specification = {
                **scheduled,
                "reference": reference_source.read_text(encoding="utf-8"),
                "sourceSha256": sha256_file(audio),
            }
            binding = {
                **common_bindings,
                "fixtureSha256": sha256_file(audio),
                "referenceSha256": sha256_file(reference_source),
                "profileSha256": sha256_bytes(canonical_json(effective_config)),
            }
            run = execute(
                command=[str(context["runtimeInputs"]["launcher"])],
                request=request,
                specification=specification,
                binding=binding,
                run_root=run_root,
                raw_root=raw_root,
                timeout_seconds=timeout_seconds,
                sampler_interval_seconds=sampler_interval_seconds,
            )
            runs.append(run)
        finally:
            shutil.rmtree(job_root, ignore_errors=True)
    require(
        len(runs) == len(context["schedule"])
        and all(run["complete"] and run["disposition"] == "SUCCESS" for run in runs),
        "development matrix is incomplete",
    )
    aggregates: dict[str, dict[str, Any]] = {}
    aggregate_paths: dict[str, str] = {}
    for candidate_id in sorted({run["candidateId"] for run in runs}):
        for profile_id in contract["profiles"]["requiredSherpaProfiles"]:
            selected = [
                run
                for run in runs
                if run["candidateId"] == candidate_id
                and run["profileId"] == profile_id
            ]
            aggregate = aggregate_candidate(selected)
            key = f"{candidate_id}/{profile_id}"
            destination = aggregates_root / candidate_id / f"{profile_id}.json"
            aggregates[key] = aggregate
            aggregate_paths[key] = str(destination.relative_to(root))
    comparisons: dict[str, dict[str, Any]] = {}
    baseline_id = contract["baselineCandidateId"]
    for profile_id in contract["profiles"]["requiredSherpaProfiles"]:
        baseline = aggregates[f"{baseline_id}/{profile_id}"]
        for candidate_id in sorted(
            value
            for value in {run["candidateId"] for run in runs}
            if value != baseline_id
        ):
            key = f"{candidate_id}/{profile_id}"
            comparisons[key] = compare_to_baseline(
                aggregates[key],
                baseline,
                hard_gates=contract["hardGates"],
                materiality=contract["materialBenefitRule"],
            )
    result = {
        "schemaVersion": 2,
        "kind": "development_matrix_result",
        "complete": True,
        "rankEligible": False,
        "heldOutDecoded": False,
        "targetFingerprint": context["targetFingerprint"],
        "contractSha256": common_bindings["contractSha256"],
        "candidateRegistrySha256": common_bindings[
            "candidateRegistrySha256"
        ],
        "fixtureManifestSha256": sha256_file(comparison / "fixtures.json"),
        "scoringContractSha256": common_bindings["scoringContractSha256"],
        "scorerSha256": common_bindings["scorerSha256"],
        "workerSha256": common_bindings["workerSha256"],
        "scheduledRunCount": len(context["schedule"]),
        "completedRunCount": len(runs),
        "warmupRunCount": sum(bool(run["warmup"]) for run in runs),
        "measuredRunCount": sum(not bool(run["warmup"]) for run in runs),
        "aggregatePaths": aggregate_paths,
        "comparisons": comparisons,
        "materialityState": contract["materialBenefitRule"]["state"],
        "developmentFreezeReady": True,
    }
    for key, aggregate in aggregates.items():
        candidate_id, profile_id = key.split("/", maxsplit=1)
        _atomic_json(
            aggregates_root / candidate_id / f"{profile_id}.json",
            aggregate,
        )
    destination = output_root / "development-matrix-result.json"
    _atomic_json(destination, result)
    return result


def current_target_fingerprint() -> dict[str, Any]:
    def sysctl(name: str) -> str:
        try:
            return subprocess.check_output(
                ["/usr/sbin/sysctl", "-n", name],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise DevelopmentMatrixError(
                f"target fingerprint unavailable: {name}"
            ) from error

    require(platform.system() == "Darwin", "development target must be macOS")
    return {
        "operatingSystem": "macos",
        "operatingSystemVersion": platform.mac_ver()[0],
        "architecture": platform.machine(),
        "cpuModel": sysctl("machdep.cpu.brand_string"),
        "logicalCpuCount": os.cpu_count(),
        "memoryBytes": int(sysctl("hw.memsize")),
    }


def validate_target_fingerprint(
    contract: dict[str, Any],
    fingerprint: dict[str, Any],
) -> None:
    target = contract["target"]
    require(
        fingerprint.get("operatingSystem") == target["operatingSystem"],
        "target operating system mismatch",
    )
    require(
        fingerprint.get("architecture") == target["architecture"],
        "target architecture mismatch",
    )
    require(
        fingerprint.get("cpuModel") == target["referenceCpuModel"],
        "target CPU model mismatch",
    )
    require(
        fingerprint.get("memoryBytes") == target["referenceMemoryBytes"],
        "target memory mismatch",
    )
    require(
        isinstance(fingerprint.get("operatingSystemVersion"), str)
        and bool(fingerprint["operatingSystemVersion"]),
        "target operating system version is missing",
    )
    require(
        isinstance(fingerprint.get("logicalCpuCount"), int)
        and fingerprint["logicalCpuCount"] > 0,
        "target logical CPU count is invalid",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--execute", action="store_true")
    parser.add_argument("--fixtures-root", type=Path)
    parser.add_argument("--assets-root", type=Path)
    parser.add_argument("--tools-root", type=Path)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--timeout-seconds", type=float, default=600)
    args = parser.parse_args()
    root = args.root.resolve()
    fixtures_root = (
        args.fixtures_root
        or root / "build/desktop_asr_comparison/fixtures/development-active"
    ).resolve()
    assets_root = (
        args.assets_root or root / "build/desktop_asr_comparison/assets"
    ).resolve()
    tools_root = (
        args.tools_root or root / "build/desktop_asr_comparison/tools/active"
    ).resolve()
    runtime_root = (
        args.runtime_root
        or root
        / "apps/desktop/build/macos/Build/Products/Debug/"
        "voice2text_desktop.app/Contents/Frameworks"
    ).resolve()
    output_root = (
        args.output_root or root / "build/desktop_asr_comparison/development/m4"
    ).resolve()
    try:
        require(
            output_root.is_relative_to(
                root / "build/desktop_asr_comparison"
            ),
            "development output must stay under the repository build root",
        )
        context = preflight_development_matrix(
            root,
            fixtures_root=fixtures_root,
            assets_root=assets_root,
            tools_root=tools_root,
            runtime_root=runtime_root,
        )
        if args.preflight:
            result = {
                "schemaVersion": 2,
                "target": context["targetFingerprint"],
                "scheduledRunCount": len(context["schedule"]),
                "admittedCandidateCount": len(context["assets"]),
                "developmentFixtureCount": len(context["fixtures"]),
                "ready": True,
            }
        else:
            result = execute_development_matrix(
                context,
                output_root=output_root,
                timeout_seconds=args.timeout_seconds,
            )
    except (
        OSError,
        json.JSONDecodeError,
        DevelopmentMatrixError,
        OrchestrationError,
        AggregationError,
    ) as error:
        print(f"development matrix: FAIL: {error}")
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
