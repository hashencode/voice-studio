#!/usr/bin/env python3
"""Run bounded Qwen3-ASR parity and formal experiments on Apple M4."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from aggregate_results import aggregate_candidate
from run_expanded_stage0 import _capabilities, _tokenizer_tree_hash
from run_macos_asr_comparison import (
    _atomic_json,
    canonical_json,
    deterministic_schedule,
    execute_run,
    sha256_bytes,
    sha256_file,
)


CANDIDATE_ID = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
RUNTIME_LANE = "sherpa-onnx-dart-1.13.4-macos-arm64"
FORMAL_REVISION = "m4_asr_comparison_revision_no_memory_gate.json"


class Qwen3ExperimentError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Qwen3ExperimentError(message)


def effective_config(profile_id: str) -> dict[str, Any]:
    require(
        profile_id in {"official-recommended", "fixed-resource"},
        "unknown Qwen3 experiment profile",
    )
    config: dict[str, Any] = {
        "modelFamily": "qwen3_asr",
        "provider": "cpu",
        "numThreads": 2,
        "modelPrecision": "int8",
        "maxTotalLen": 512,
        "maxNewTokens": 512,
        "temperature": 0.000001,
        "topP": 0.8,
        "seed": 42,
        "hotwords": "",
    }
    if profile_id == "fixed-resource":
        config.update(
            {
                "concurrency": 1,
                "inputMode": "frozen_segments",
                "segmentDurationSeconds": 15,
                "pacingPolicy": "unpaced",
                "warmupRuns": 1,
                "measuredRuns": 5,
            }
        )
    return config


def _model_files(
    experiment: dict[str, Any], model_root: Path
) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for role, binding in experiment["candidate"]["artifacts"].items():
        path = model_root / binding["relativePath"]
        require(path.exists(), f"Qwen3 model role is missing: {role}")
        actual = (
            _tokenizer_tree_hash(path)
            if role == "tokenizer"
            else sha256_file(path)
        )
        require(actual == binding["sha256"], f"Qwen3 model hash mismatch: {role}")
        result[role] = {"path": str(path), "sha256": actual}
    return result


def _formal_revision(comparison_root: Path) -> tuple[Path, dict[str, Any]]:
    path = comparison_root / FORMAL_REVISION
    revision = json.loads(path.read_text(encoding="utf-8"))
    policy = revision["selectionPolicy"]
    require(
        policy["memory"]["hardGate"] is False
        and policy["memory"]["disposition"] == "advisory_only",
        "formal revision must keep memory advisory-only",
    )
    require(
        policy["hardGates"]
        == {
            "maximumCer": 0.35,
            "maximumWer": 0.35,
            "maximumRtf": 0.5,
        },
        "formal quality/RTF gates drifted",
    )
    return path, revision


def run(args: argparse.Namespace) -> dict[str, Any]:
    comparison_root = Path(__file__).resolve().parent
    experiment_path = comparison_root / "qwen3_experiment_m4.json"
    experiment = json.loads(experiment_path.read_text(encoding="utf-8"))
    require(
        experiment["candidate"]["candidateId"] == CANDIDATE_ID,
        "Qwen3 experiment identity mismatch",
    )
    fixture_root = args.fixture_root.resolve()
    manifest_path = fixture_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(
        manifest["languageLane"] == args.language_lane,
        "fixture language lane mismatch",
    )
    fixtures = [
        item
        for item in manifest["fixtures"]
        if item["fixtureRole"] == args.fixture_role
    ]
    require(fixtures, "Qwen3 experiment requires at least one matching fixture")
    formal_revision_path: Path | None = None
    formal_revision: dict[str, Any] | None = None
    if args.experiment_kind == "parity":
        require(len(fixtures) == 1, "Qwen3 parity requires one bounded fixture")
        require(
            fixtures[0]["durationSeconds"] <= 15,
            "official-vs-fixed parity fixture must fit one fixed segment",
        )
    else:
        require(
            args.profile_id == "fixed-resource",
            "formal Qwen3 runs require the fixed-resource profile",
        )
        require(
            args.fixture_role
            in {"stability", "development", "held_out", "operational"},
            "formal Qwen3 fixture role is invalid",
        )
        formal_revision_path, formal_revision = _formal_revision(comparison_root)

    runtime_root = args.runtime_root.resolve()
    tools_root = args.tools_root.resolve()
    output_root = args.output_root.resolve()
    model_root = args.model_root.resolve()
    runtime = runtime_root / "libsherpa-onnx-c-api.dylib"
    launcher = tools_root / "sandboxed_candidate_launcher"
    worker = tools_root / "desktop_asr_candidate_worker"
    process_group = tools_root / "native_process_group_launcher"
    for path in (runtime, launcher, worker, process_group):
        require(path.is_file(), f"required runtime/tool missing: {path.name}")

    profile_id = args.profile_id
    profile = effective_config(profile_id)
    model_files = _model_files(experiment, model_root)
    rank_eligible = args.experiment_kind == "formal"
    matrix = [
        {
            "candidateId": CANDIDATE_ID,
            "profileId": (
                "recommended"
                if profile_id == "official-recommended"
                else "fixed-resource"
            ),
            "fixtureId": fixture["fixtureId"],
            "laneId": RUNTIME_LANE,
            "scorecard": "core_asr",
            "scenario": fixture["scenario"],
            "rankEligible": rank_eligible,
            "observationSource": (
                "m4_qwen3_formal_real_authorized"
                if rank_eligible
                else "m4_qwen3_parameter_parity_real_authorized"
            ),
            "pacingPolicy": "unpaced",
        }
        for fixture in fixtures
    ]
    schedule = deterministic_schedule(
        matrix,
        seed=20260726,
        warmup_runs=args.warmup_runs,
        measured_runs=args.measured_runs,
    )
    output_root.mkdir(parents=True, exist_ok=True)
    run_root = output_root / "runs"
    raw_root = output_root / "raw"
    records: list[dict[str, Any]] = []
    fixtures_by_id = {item["fixtureId"]: item for item in fixtures}
    for scheduled in schedule:
        fixture = fixtures_by_id[scheduled["fixtureId"]]
        source_fixture = fixture_root / fixture["audioRelativePath"]
        reference_path = fixture_root / fixture["referenceRelativePath"]
        require(
            sha256_file(source_fixture) == fixture["audioSha256"],
            "fixture audio hash mismatch",
        )
        require(
            sha256_file(reference_path) == fixture["referenceSha256"],
            "fixture reference hash mismatch",
        )
        job_root = output_root / "jobs" / (
            f"{profile_id}-{scheduled['runIndex']}-"
            f"{'warmup' if scheduled['warmup'] else 'measured'}"
        )
        shutil.rmtree(job_root, ignore_errors=True)
        input_root = job_root / "input"
        input_root.mkdir(parents=True)
        source = input_root / "audio.wav"
        shutil.copyfile(source_fixture, source)
        request = {
            "roots": {
                "jobRoot": str(job_root),
                "runtimeRoot": str(runtime_root),
                "modelRoot": str(model_root),
                "toolRoot": str(tools_root),
            },
            "nativeProcessGroupLauncher": str(process_group),
            "worker": str(worker),
            "workerRequest": {
                "schemaVersion": 2,
                "candidateId": CANDIDATE_ID,
                "family": "qwen3_asr",
                "profileId": scheduled["profileId"],
                "sourcePath": str(source),
                "sourceSha256": sha256_file(source),
                "modelFiles": model_files,
                "effectiveConfig": profile,
                "capabilities": _capabilities("qwen3_asr"),
                "expectSpeech": True,
                "settleMilliseconds": 1000,
            },
        }
        specification = {
            **scheduled,
            "reference": reference_path.read_text(encoding="utf-8").strip(),
            "sourceSha256": sha256_file(source),
        }
        binding = {
            "contractSha256": sha256_file(
                formal_revision_path
                if formal_revision_path is not None
                else comparison_root / "macos_contract.json"
            ),
            "candidateRegistrySha256": sha256_file(experiment_path),
            "scoringContractSha256": sha256_file(
                comparison_root / "scoring_contract.json"
            ),
            "scorerSha256": sha256_file(comparison_root / "asr_scoring.py"),
            "runtimeSha256": sha256_file(runtime),
            "workerSha256": sha256_file(worker),
            "fixtureSha256": fixture["audioSha256"],
            "referenceSha256": fixture["referenceSha256"],
            "profileSha256": sha256_bytes(canonical_json(profile)),
        }
        try:
            record = execute_run(
                command=[str(launcher)],
                request=request,
                specification=specification,
                binding=binding,
                run_root=run_root,
                raw_root=raw_root,
                timeout_seconds=args.timeout_seconds,
                sampler_interval_seconds=0.02,
            )
            records.append(record)
            print(
                json.dumps(
                    {
                        "completedRuns": len(records),
                        "fixtureId": fixture["fixtureId"],
                        "runIndex": scheduled["runIndex"],
                        "warmup": scheduled["warmup"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
        finally:
            shutil.rmtree(job_root, ignore_errors=True)
    summary = {
        "schemaVersion": 1,
        "kind": (
            "m4_qwen3_asr_formal_evidence"
            if rank_eligible
            else "m4_qwen3_asr_parameter_parity"
        ),
        "stage": args.fixture_role,
        "candidateId": CANDIDATE_ID,
        "languageLane": args.language_lane,
        "lexicalMetric": "cer" if args.language_lane == "zh" else "wer",
        "profileId": profile_id,
        "rankEligible": rank_eligible,
        "selectionPolicy": (
            formal_revision["selectionPolicy"]
            if formal_revision is not None
            else {
                "rankEligible": False,
                "memory": {"disposition": "observation_only"},
            }
        ),
        "fixtureManifestSha256": sha256_file(manifest_path),
        "experimentManifestSha256": sha256_file(experiment_path),
        "aggregate": aggregate_candidate(records),
        "observations": [
            {
                "runId": item["runId"],
                "warmup": item["warmup"],
                "runIndex": item["runIndex"],
                "rawOutputSha256": item["rawOutputSha256"],
                "metrics": item["metrics"],
                "resources": item["resources"],
            }
            for item in records
        ],
        "privacy": {
            "rawAudioPublished": False,
            "referenceTextPublished": False,
            "transcriptPublished": False,
            "modelFilesPublished": False,
            "absolutePathsPublished": False,
            "processingNetwork": "denied",
        },
    }
    _atomic_json(output_root / "summary.json", summary)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--language-lane", choices=("zh", "en"), required=True)
    parser.add_argument(
        "--experiment-kind",
        choices=("parity", "formal"),
        default="parity",
    )
    parser.add_argument(
        "--profile-id",
        choices=("official-recommended", "fixed-resource"),
        required=True,
    )
    parser.add_argument("--fixture-role", default="streaming")
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--tools-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--measured-runs", type=int, default=5)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    args = parser.parse_args()
    try:
        summary = run(args)
    except (OSError, json.JSONDecodeError, Qwen3ExperimentError) as error:
        print(f"Qwen3 M4 experiment: FAIL: {error}")
        return 1
    print(
        json.dumps(
            {
                "candidateId": summary["candidateId"],
                "languageLane": summary["languageLane"],
                "profileId": summary["profileId"],
                "measuredRuns": summary["aggregate"]["measuredRunCount"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
