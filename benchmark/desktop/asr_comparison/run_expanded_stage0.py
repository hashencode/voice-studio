#!/usr/bin/env python3
"""Run one privacy-safe M4 Stage 0 smoke for the Mandarin/English expansion."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from expanded_round import (
    ExpansionError,
    effective_config,
    lexical_metric_for_lane,
    validate_expansion,
)
from run_macos_asr_comparison import (
    OrchestrationError,
    _atomic_json,
    canonical_json,
    execute_run,
    sha256_bytes,
    sha256_file,
)


class ExpandedSmokeError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ExpandedSmokeError(message)


def _candidate(
    candidate_id: str,
    expansion: dict[str, Any],
    base_registry: dict[str, Any],
) -> dict[str, Any]:
    new = [
        candidate
        for candidate in expansion["newCandidates"]
        if candidate["candidateId"] == candidate_id
    ]
    if new:
        require(len(new) == 1, "candidate must resolve exactly once")
        return new[0]
    overrides = [
        override
        for override in expansion["candidateOverrides"]
        if override["candidateId"] == candidate_id
    ]
    require(len(overrides) == 1, "candidate is not in the M4 expansion")
    base = next(
        candidate
        for candidate in base_registry["candidates"]
        if candidate["candidateId"] == candidate_id
    )
    return {
        **overrides[0],
        "displayName": base["displayName"],
        "family": base["family"],
        "role": base["role"],
    }


def _capabilities(family: str) -> dict[str, bool]:
    streaming = family == "streaming_zipformer_transducer"
    generative = family in {"funasr_nano", "qwen3_asr"}
    qwen3 = family == "qwen3_asr"
    sense_voice = family == "sense_voice"
    return {
        "streaming": streaming,
        "timestamps": not generative,
        "partialResults": streaming,
        "endpointing": streaming,
        "hotwords": generative,
        "punctuation": generative or sense_voice,
        "itn": (generative and not qwen3) or sense_voice,
        "seededGeneration": generative,
    }


def run_smoke(args: argparse.Namespace) -> dict[str, Any]:
    comparison = Path(__file__).resolve().parent
    for field in (
        "audio",
        "reference",
        "model_root",
        "runtime_root",
        "tools_root",
        "output_root",
    ):
        setattr(args, field, getattr(args, field).resolve())
    expansion_path = comparison / "expanded_candidates_m4.json"
    base_path = comparison / "candidates.json"
    contract_path = comparison / "macos_contract.json"
    scoring_path = comparison / "scoring_contract.json"
    scorer_path = comparison / "asr_scoring.py"
    expansion = json.loads(expansion_path.read_text())
    base_registry = json.loads(base_path.read_text())
    validate_expansion(expansion, base_registry)
    candidate = _candidate(args.candidate, expansion, base_registry)
    require(
        args.language_lane in candidate["languageLanes"],
        "candidate does not support the requested language lane",
    )
    require(args.audio.is_file() and args.reference.is_file(), "smoke fixture missing")
    require(args.runtime_root.is_dir(), "runtime root missing")
    for tool in (
        "sandboxed_candidate_launcher",
        "desktop_asr_candidate_worker",
        "native_process_group_launcher",
    ):
        require((args.tools_root / tool).is_file(), f"tool missing: {tool}")

    candidate_model_root = args.model_root / args.candidate
    artifacts = candidate["artifacts"]
    model_files: dict[str, dict[str, str]] = {}
    for role, expected_hash in artifacts.items():
        path = candidate_model_root / role
        require(path.exists(), f"model role missing: {role}")
        actual_hash = (
            _tokenizer_tree_hash(path)
            if role == "tokenizer" and path.is_dir()
            else sha256_file(path)
        )
        require(actual_hash == expected_hash, f"model hash mismatch: {role}")
        model_files[role] = {"path": str(path), "sha256": actual_hash}

    output_root = args.output_root
    run_root = output_root / "runs"
    raw_root = output_root / "raw"
    job_root = output_root / "jobs" / f"{args.candidate}-{args.language_lane}"
    if job_root.exists():
        shutil.rmtree(job_root)
    input_root = job_root / "input"
    input_root.mkdir(parents=True)
    source = input_root / "smoke.wav"
    shutil.copyfile(args.audio, source)
    reference_text = args.reference.read_text(encoding="utf-8").strip()
    require(reference_text, "speech smoke reference must not be empty")
    profile = effective_config(
        candidate["family"],
        language_lane=args.language_lane,
        profile_id="recommended",
    )
    worker = args.tools_root / "desktop_asr_candidate_worker"
    launcher = args.tools_root / "sandboxed_candidate_launcher"
    process_group = args.tools_root / "native_process_group_launcher"
    runtime = args.runtime_root / "libsherpa-onnx-c-api.dylib"
    require(runtime.is_file(), "sherpa runtime missing")
    request = {
        "roots": {
            "jobRoot": str(job_root),
            "runtimeRoot": str(args.runtime_root),
            "modelRoot": str(args.model_root),
            "toolRoot": str(args.tools_root),
        },
        "nativeProcessGroupLauncher": str(process_group),
        "worker": str(worker),
        "workerRequest": {
            "schemaVersion": 2,
            "candidateId": args.candidate,
            "family": candidate["family"],
            "profileId": "recommended",
            "sourcePath": str(source),
            "sourceSha256": sha256_file(source),
            "modelFiles": model_files,
            "effectiveConfig": profile,
            "capabilities": _capabilities(candidate["family"]),
            "expectSpeech": True,
            "settleMilliseconds": 1000,
        },
    }
    specification = {
        "candidateId": args.candidate,
        "profileId": "recommended",
        "fixtureId": f"local-stage0-{args.language_lane}",
        "laneId": expansion["runtimeLaneId"],
        "scorecard": "core_asr",
        "scenario": (
            "clean_near_field_mandarin"
            if args.language_lane == "zh"
            else "clean_near_field_english"
        ),
        "reference": reference_text,
        "rankEligible": False,
        "observationSource": "m4_expanded_stage0_smoke",
        "pacingPolicy": profile.get("pacingPolicy", "unpaced"),
        "runIndex": 0,
        "warmup": False,
        "scheduleOrder": 0,
        "sourceSha256": sha256_file(source),
    }
    binding = {
        "contractSha256": sha256_file(contract_path),
        "candidateRegistrySha256": sha256_file(expansion_path),
        "scoringContractSha256": sha256_file(scoring_path),
        "scorerSha256": sha256_file(scorer_path),
        "runtimeSha256": sha256_file(runtime),
        "workerSha256": sha256_file(worker),
        "fixtureSha256": sha256_file(source),
        "referenceSha256": sha256_file(args.reference),
        "profileSha256": sha256_bytes(canonical_json(profile)),
    }
    try:
        result = execute_run(
            command=[str(launcher)],
            request=request,
            specification=specification,
            binding=binding,
            run_root=run_root,
            raw_root=raw_root,
            timeout_seconds=args.timeout_seconds,
            sampler_interval_seconds=0.02,
        )
    finally:
        shutil.rmtree(job_root, ignore_errors=True)
    metric = lexical_metric_for_lane(expansion, args.language_lane)
    summary = {
        "schemaVersion": 1,
        "kind": "m4_expanded_stage0_smoke",
        "candidateId": args.candidate,
        "languageLane": args.language_lane,
        "lexicalMetric": metric,
        "runId": result["runId"],
        "complete": result["complete"],
        "disposition": result["disposition"],
        "rankEligible": False,
        "metrics": result["metrics"],
        "resources": result["resources"],
        "privacy": {
            "rawAudioPublished": False,
            "transcriptPublished": False,
            "modelFilesPublished": False,
            "processingNetwork": "denied",
        },
    }
    _atomic_json(
        output_root / "summaries" / f"{args.candidate}-{args.language_lane}.json",
        summary,
    )
    return summary


def _tokenizer_tree_hash(path: Path) -> str:
    require(path.is_dir(), "tokenizer role must be a directory")
    files = sorted(item for item in path.iterdir() if item.is_file())
    require(0 < len(files) <= 16, "tokenizer directory is invalid")
    identity = "".join(
        f"{item.name}\0{sha256_file(item)}\n"
        for item in files
    ).encode()
    return sha256_bytes(identity)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--language-lane", choices=("zh", "en"), required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--tools-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    args = parser.parse_args()
    try:
        summary = run_smoke(args)
    except (
        OSError,
        json.JSONDecodeError,
        ExpansionError,
        ExpandedSmokeError,
        OrchestrationError,
    ) as error:
        print(f"M4 expanded Stage 0: FAIL: {error}")
        return 1
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
