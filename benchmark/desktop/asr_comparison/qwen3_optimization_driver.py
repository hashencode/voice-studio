#!/usr/bin/env python3
"""Execute the frozen Apple M4 Qwen3 optimization matrix fail closed."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

from evaluate_qwen3_optimization import validate_contract
ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = Path(__file__).with_name("qwen3_optimization_contract.json")


class DriverError(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def nearest_rank_percentile(values: list[float], percentile: float) -> float:
    require(bool(values), "percentile requires values")
    ordered = sorted(float(value) for value in values)
    return ordered[max(0, math.ceil(percentile * len(ordered)) - 1)]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DriverError(message)


def object_value(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def load_json(path: Path) -> dict[str, Any]:
    return object_value(json.loads(path.read_text(encoding="utf-8")), str(path))


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def verify_file(path: Path, expected: str, label: str) -> None:
    require(path.is_file(), f"{label} is missing")
    require(sha256_file(path) == expected, f"{label} hash drifted")


def verify_directory(path: Path, expected: str, label: str) -> None:
    require(path.is_dir(), f"{label} is missing")
    files = sorted(item for item in path.iterdir() if item.is_file())
    require(0 < len(files) <= 16, f"{label} directory is invalid")
    identity = "".join(f"{item.name}\0{sha256_file(item)}\n" for item in files)
    require(sha256_bytes(identity.encode()) == expected, f"{label} hash drifted")


def validate_target_host(target: dict[str, Any], build_mode: Any) -> None:
    require(platform.system() == "Darwin", "target OS is not macOS")
    require(
        f"macOS {platform.mac_ver()[0]}" == target["os"],
        "target macOS version drifted",
    )
    build = subprocess.run(
        ["/usr/bin/sw_vers", "-buildVersion"],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    require(build == target["osBuild"], "target macOS build drifted")
    require(platform.machine() == target["architecture"], "target architecture drifted")

    def sysctl(name: str) -> str:
        result = subprocess.run(
            ["/usr/sbin/sysctl", "-n", name],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip()

    require(sysctl("machdep.cpu.brand_string") == target["cpu"], "target CPU drifted")
    require(
        int(sysctl("hw.logicalcpu")) == target["logicalCpuCount"],
        "target logical CPU count drifted",
    )
    require(int(sysctl("hw.memsize")) == target["memoryBytes"], "target memory drifted")
    require(build_mode == target["buildMode"] == "debug", "build mode drifted")


def resolve_fixtures(
    contract: dict[str, Any],
    manifest: dict[str, Any],
    audio_root: Path,
) -> list[dict[str, Any]]:
    required = contract["inputs"]["requiredScenarios"]
    fixtures = manifest.get("fixtures")
    require(isinstance(fixtures, list), "fixture manifest is invalid")
    resolved: list[dict[str, Any]] = []
    for scenario in required:
        matches = [
            object_value(item, "fixture")
            for item in fixtures
            if isinstance(item, dict)
            and item.get("scenario") == scenario
            and item.get("fixtureRole") == "held_out"
            and item.get("freezeState") == "FROZEN"
        ]
        require(
            len(matches) == 1,
            f"{scenario} requires exactly one frozen held-out fixture",
        )
        fixture = matches[0]
        audio = object_value(fixture.get("audio"), f"{scenario}.audio")
        reference = object_value(fixture.get("reference"), f"{scenario}.reference")
        audio_path = audio_root / str(audio.get("relativePath"))
        reference_path = audio_root / str(reference.get("relativePath"))
        verify_file(audio_path, str(audio.get("sha256")), f"{scenario} audio")
        verify_file(
            reference_path,
            str(reference.get("sha256")),
            f"{scenario} reference",
        )
        annotations = fixture.get("annotations")
        if scenario == "terminology_numbers":
            require(
                isinstance(annotations, dict)
                and isinstance(annotations.get("terminology"), list)
                and annotations["terminology"],
                "terminology fixture requires frozen terminology annotations",
            )
        resolved.append(
            {
                "fixtureId": fixture["fixtureId"],
                "scenario": scenario,
                "sourcePath": str(audio_path.resolve()),
                "sourceSha256": audio["sha256"],
                "reference": reference_path.read_text(encoding="utf-8"),
                "referenceSha256": reference["sha256"],
                "annotations": annotations if isinstance(annotations, dict) else {},
            }
        )
    return resolved


def build_profiles(contract: dict[str, Any], hotwords: str) -> list[dict[str, Any]]:
    control = dict(contract["control"])
    profiles: dict[str, dict[str, Any]] = {"control": control}
    output = [
        {
            "id": "control",
            "baseArmId": None,
            "changedVariable": None,
            "config": control,
        }
    ]
    for arm in contract["arms"]:
        base_id = arm["baseArmId"]
        require(base_id in profiles, f"{arm['id']} base arm is unavailable")
        config = dict(profiles[base_id])
        value = hotwords if arm["variable"] == "hotwords" else arm["value"]
        config[arm["variable"]] = value
        profiles[arm["id"]] = config
        output.append(
            {
                "id": arm["id"],
                "baseArmId": base_id,
                "changedVariable": arm["variable"],
                "config": config,
                "runtimeSha256": arm.get("runtimeSha256"),
            }
        )
    return output


def bounded_hotwords(
    fixtures: list[dict[str, Any]], contract: dict[str, Any]
) -> str:
    terms: list[str] = []
    for fixture in fixtures:
        for event in fixture["annotations"].get("terminology", []):
            alternatives = event.get("expectedAlternatives", [])
            if alternatives:
                terms.append(str(alternatives[0]).strip())
    bounds = contract["hotwordBounds"]
    unique: list[str] = []
    total = 0
    for term in terms:
        if not term or term in unique:
            continue
        require(len(term) <= bounds["maximumTermCharacters"], "hotword is too long")
        require(
            total + len(term) <= bounds["maximumTotalCharacters"],
            "hotword pack is too large",
        )
        unique.append(term)
        total += len(term)
        require(len(unique) <= bounds["maximumTerms"], "too many hotwords")
    require(unique, "the frozen terminology pack produced no hotwords")
    return " ".join(unique)


def model_files(config: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    model_root = Path(config["modelRoot"]).resolve()
    hashes = contract["model"]["hashes"]
    paths = {
        "convFrontend": model_root / "conv_frontend.onnx",
        "encoder": model_root / "encoder.int8.onnx",
        "decoder": model_root / "decoder.int8.onnx",
        "tokenizer": model_root / "tokenizer",
        "sileroVad": Path(config["sileroVad"]).resolve(),
    }
    for role, path in paths.items():
        expected = hashes["tokenizerTree" if role == "tokenizer" else role]
        if role == "tokenizer":
            verify_directory(path, expected, role)
        else:
            verify_file(path, expected, role)
    return {
        role: {
            "path": str(path),
            "sha256": hashes["tokenizerTree" if role == "tokenizer" else role],
        }
        for role, path in paths.items()
    }


def runtime_lane(
    profile: dict[str, Any], config: dict[str, Any], contract: dict[str, Any]
) -> tuple[Path, str]:
    runtime_id = profile["config"]["runtime"]
    lanes = object_value(config.get("runtimeLanes"), "runtimeLanes")
    lane = object_value(lanes.get(runtime_id), f"runtime lane {runtime_id}")
    root = Path(lane["root"]).resolve()
    archive = Path(lane["archive"]).resolve()
    expected = (
        profile.get("runtimeSha256")
        or contract["control"]["runtimeSha256"]
    )
    verify_file(archive, expected, f"{runtime_id} archive")
    require(root.is_dir(), f"{runtime_id} root is missing")
    return root, expected


def raw_result(raw_root: Path, run_id: str) -> dict[str, Any]:
    document = load_json(raw_root / f"{run_id}.json")
    results = [
        event for event in document["events"] if event.get("type") == "result"
    ]
    require(len(results) == 1, "raw worker result is missing")
    return results[0]


def aggregate_arm(
    profile: dict[str, Any],
    records: list[dict[str, Any]],
    raw_root: Path,
    elapsed_seconds: float,
    model_hashes: dict[str, Any],
    cancellation_clean: bool,
) -> dict[str, Any]:
    measured = [record for record in records if not record["warmup"]]
    require(measured, "arm has no measured runs")
    speech = [
        record
        for record in measured
        if record["scenario"] != "non_speech"
        and record["metrics"]["cer"] is not None
    ]
    non_target = [
        record
        for record in speech
        if record["scenario"] != "terminology_numbers"
    ]
    terminology = [
        record["metrics"]["terminologyRecall"]
        for record in measured
        if record["scenario"] == "terminology_numbers"
        and record["metrics"]["terminologyRecall"] is not None
    ]
    raw = [raw_result(raw_root, record["runId"]) for record in measured]
    maximum_tokens = int(profile["config"]["maxNewTokens"])
    return {
        "id": profile["id"],
        "baseArmId": profile["baseArmId"],
        "changedVariable": profile["changedVariable"],
        "modelHashes": model_hashes,
        "probeDurationSeconds": elapsed_seconds,
        "warmupRuns": 1,
        "measuredRuns": 3,
        "errorRate": statistics.fmean(record["metrics"]["cer"] for record in speech),
        "nonTargetErrorRate": statistics.fmean(
            record["metrics"]["cer"] for record in non_target
        ),
        "targetTermRecall": statistics.fmean(terminology),
        "rtf": statistics.fmean(record["metrics"]["rtf"] for record in measured),
        "peakRssBytes": max(
            record["metrics"]["incrementalPeakRssBytes"] for record in measured
        ),
        "retainedRssBytes": max(
            record["metrics"]["retainedRssBytesAfterUnload"] for record in measured
        ),
        "coldLoadMs": max(
            record["metrics"]["loadMilliseconds"]
            for record in records
            if record["warmup"]
        ),
        "warmLoadMs": statistics.median(
            record["metrics"]["loadMilliseconds"] for record in measured
        ),
        "p95SegmentLatencyMs": nearest_rank_percentile(
            [
                record["metrics"]["segmentLatencyP95Milliseconds"]
                for record in measured
            ],
            0.95,
        ),
        "cancellationClean": cancellation_clean,
        "temporaryFilesClean": all(
            record["temporaryArtifactsReleased"] for record in records
        ),
        "truncated": any(len(result["tokens"]) >= maximum_tokens for result in raw),
        "hallucinated": any(
            result["text"].strip()
            for record, result in zip(measured, raw)
            if record["scenario"] == "non_speech"
        ),
    }


def cancellation_probe(
    *,
    command: list[str],
    request: dict[str, Any],
    specification: dict[str, Any],
    binding: dict[str, Any],
    run_root: Path,
    raw_root: Path,
) -> bool:
    from run_macos_asr_comparison import (
        OrchestrationError,
        deterministic_run_id,
        execute_run,
    )

    probe_specification = {
        **specification,
        "runIndex": 99_999,
        "warmup": True,
        "scheduleOrder": 99_999,
    }
    run_id = deterministic_run_id(probe_specification, binding)
    try:
        execute_run(
            command=command,
            request=request,
            specification=probe_specification,
            binding=binding,
            run_root=run_root,
            raw_root=raw_root,
            timeout_seconds=0.01,
            sampler_interval_seconds=0.01,
        )
    except OrchestrationError as error:
        if error.code != "TIMEOUT":
            return False
        staging = load_json(run_root / ".staging" / f"{run_id}.json")
        termination = object_value(staging.get("termination"), "termination")
        return bool(
            staging.get("temporaryArtifactsReleased")
            and termination.get("processGroupGone")
            and termination.get("descendantProcessesGone")
        )
    return False


def execute(config: dict[str, Any], contract_path: Path) -> dict[str, Any]:
    from run_macos_asr_comparison import execute_run

    contract = load_json(contract_path)
    validate_contract(contract)
    validate_target_host(contract["target"], config.get("buildMode"))
    inputs = contract["inputs"]
    manifest_path = ROOT / inputs["fixtureManifestPath"]
    scoring_path = ROOT / inputs["scoringContractPath"]
    verify_file(manifest_path, inputs["fixtureManifestSha256"], "fixture manifest")
    verify_file(scoring_path, inputs["scoringContractSha256"], "scoring contract")
    fixtures = resolve_fixtures(contract, load_json(manifest_path), Path(config["audioRoot"]))
    profiles = build_profiles(contract, bounded_hotwords(fixtures, contract))
    bound_models = model_files(config, contract)
    job_root = Path(config["jobRoot"]).resolve()
    require(job_root.is_dir(), "job root is missing")
    for fixture in fixtures:
        try:
            Path(fixture["sourcePath"]).resolve().relative_to(job_root)
        except ValueError as error:
            raise DriverError("fixture source is outside the sandbox job root") from error

    launcher = Path(config["sandboxLauncher"]).resolve()
    native_launcher = Path(config["nativeProcessGroupLauncher"]).resolve()
    worker = Path(config["worker"]).resolve()
    for executable, label in (
        (launcher, "sandbox launcher"),
        (native_launcher, "native process-group launcher"),
        (worker, "Qwen3 worker"),
    ):
        require(executable.is_file(), f"{label} is missing")
    try:
        native_launcher.relative_to(worker.parent)
        Path(config["sileroVad"]).resolve().relative_to(Path(config["modelRoot"]).resolve())
    except ValueError as error:
        raise DriverError("sandboxed tools/models escape their declared roots") from error
    command = [str(launcher)]
    output_path = Path(config["output"]).resolve()
    evidence_root = output_path.parent
    run_root = evidence_root / "runs"
    raw_root = evidence_root / "raw"
    schedule_order = 0
    arm_observations: list[dict[str, Any]] = []
    for profile in profiles:
        arm_started = time.monotonic()
        runtime_root, runtime_sha = runtime_lane(profile, config, contract)
        records: list[dict[str, Any]] = []
        last_inputs: tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None = None
        for run_index in range(4):
            for fixture in fixtures:
                effective = {
                    "provider": profile["config"]["provider"],
                    "numThreads": profile["config"]["threads"],
                    "maxTotalLen": profile["config"]["maxTotalLen"],
                    "maxNewTokens": profile["config"]["maxNewTokens"],
                    "temperature": profile["config"]["temperature"],
                    "topP": profile["config"]["topP"],
                    "seed": profile["config"]["seed"],
                    "hotwords": profile["config"]["hotwords"],
                    "segmentDurationSeconds": profile["config"]["segmentDurationSeconds"],
                    "maxSpeechSeconds": profile["config"]["maxSpeechSeconds"],
                    "vadThreshold": profile["config"]["vadThreshold"],
                    "minSpeechSeconds": profile["config"]["minSpeechSeconds"],
                }
                worker_request = {
                    "schemaVersion": 2,
                    "candidateId": contract["model"]["id"],
                    "family": "qwen3_asr",
                    "profileId": "fixed-resource",
                    "sourcePath": fixture["sourcePath"],
                    "sourceSha256": fixture["sourceSha256"],
                    "modelFiles": bound_models,
                    "effectiveConfig": effective,
                    "capabilities": {
                        "streaming": False,
                        "timestamps": False,
                        "partialResults": False,
                        "endpointing": profile["config"]["segmentation"]
                        == "official_silero_vad",
                        "hotwords": True,
                        "punctuation": True,
                        "itn": False,
                        "seededGeneration": True,
                    },
                    "expectSpeech": fixture["scenario"] != "non_speech",
                    "settleMilliseconds": 250,
                    "diagnosticSegmentation": (
                        "official_silero_vad"
                        if profile["config"]["segmentation"] == "official_silero_vad"
                        else "fixed_15_seconds"
                    ),
                }
                request = {
                    "roots": {
                        "jobRoot": str(job_root),
                        "runtimeRoot": str(runtime_root),
                        "modelRoot": str(Path(config["modelRoot"]).resolve()),
                        "toolRoot": str(worker.parent),
                    },
                    "nativeProcessGroupLauncher": str(native_launcher),
                    "worker": str(worker),
                    "workerRequest": worker_request,
                }
                specification = {
                    "candidateId": contract["model"]["id"],
                    "laneId": profile["config"]["runtime"],
                    "profileId": "fixed-resource",
                    "fixtureId": fixture["fixtureId"],
                    "scenario": fixture["scenario"],
                    "scorecard": "qwen3_optimization",
                    "runIndex": run_index,
                    "warmup": run_index == 0,
                    "scheduleOrder": schedule_order,
                    "reference": fixture["reference"],
                    "annotations": fixture["annotations"],
                    "sourceSha256": fixture["sourceSha256"],
                    "rankEligible": True,
                    "pacingPolicy": "unpaced",
                }
                profile_sha = sha256_bytes(canonical_json(effective))
                binding = {
                    "contractSha256": sha256_file(contract_path),
                    "candidateRegistrySha256": sha256_file(
                        ROOT / "benchmark/desktop/asr_comparison/pc_qwen3_optimization_baseline.json"
                    ),
                    "scoringContractSha256": inputs["scoringContractSha256"],
                    "scorerSha256": sha256_file(
                        ROOT / "benchmark/desktop/asr_comparison/asr_scoring.py"
                    ),
                    "runtimeSha256": runtime_sha,
                    "workerSha256": sha256_file(worker),
                    "fixtureSha256": fixture["sourceSha256"],
                    "referenceSha256": fixture["referenceSha256"],
                    "profileSha256": profile_sha,
                }
                remaining = 1800 - (time.monotonic() - arm_started)
                require(remaining > 0, f"{profile['id']} exceeded 30 minutes")
                records.append(
                    execute_run(
                        command=command,
                        request=request,
                        specification=specification,
                        binding=binding,
                        run_root=run_root,
                        raw_root=raw_root,
                        timeout_seconds=min(remaining, 1800),
                        sampler_interval_seconds=0.02,
                    )
                )
                last_inputs = request, specification, binding
                schedule_order += 1
        require(last_inputs is not None, "arm schedule is empty")
        cancellation_clean = cancellation_probe(
            command=command,
            request=last_inputs[0],
            specification=last_inputs[1],
            binding=last_inputs[2],
            run_root=run_root,
            raw_root=raw_root,
        )
        elapsed = time.monotonic() - arm_started
        require(elapsed <= 1800, f"{profile['id']} exceeded 30 minutes")
        arm_observations.append(
            aggregate_arm(
                profile,
                records,
                raw_root,
                elapsed,
                contract["model"]["hashes"],
                cancellation_clean,
            )
        )
    result = {
        "schemaVersion": 2,
        "contractId": contract["contractId"],
        "status": "COMPLETE",
        "target": contract["target"],
        "fixtureManifestSha256": inputs["fixtureManifestSha256"],
        "scoringContractSha256": inputs["scoringContractSha256"],
        "arms": arm_observations,
    }
    atomic_json(output_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    args = parser.parse_args()
    try:
        result = execute(load_json(args.config), args.contract.resolve())
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    except (
        DriverError,
        OSError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        ValueError,
        RuntimeError,
    ) as error:
        print(f"FAIL: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
