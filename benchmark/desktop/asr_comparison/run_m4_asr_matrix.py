#!/usr/bin/env python3
"""Execute privacy-safe fixed-resource M4 Mandarin/English ASR matrices."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from aggregate_results import aggregate_candidate
from expanded_round import effective_config, validate_expansion
from run_expanded_stage0 import _capabilities, _tokenizer_tree_hash
from run_macos_asr_comparison import (
    OrchestrationError,
    _atomic_json,
    canonical_json,
    deterministic_schedule,
    execute_run,
    sha256_bytes,
    sha256_file,
)


RUNTIME_LANE = "sherpa-onnx-dart-1.13.4-macos-arm64"
LANGUAGE_CANDIDATES = {
    "zh": (
        "sherpa-streaming-zipformer-zh-14m-2023-02-23",
        "sherpa-onnx-paraformer-zh-int8-2025-10-07",
        "sherpa-onnx-paraformer-zh-2024-03-09",
        "sherpa-onnx-funasr-nano-int8-2025-12-30",
        "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
        "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    ),
    "en": (
        "sherpa-onnx-streaming-zipformer-en-20m-2023-02-17",
        "sherpa-onnx-whisper-base-en-int8-2023-01-31",
        "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8-2025-05-01",
        "sherpa-onnx-funasr-nano-int8-2025-12-30",
        "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
        "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    ),
}
RUNTIME_REJECTIONS = {
    "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30": {
        "languageLane": "zh",
        "disposition": "REJECTED_RUNTIME_MODEL_METADATA",
        "failureCode": "ZIPFORMER_ATTENTION_DIMS_METADATA_MISSING",
    },
    "sherpa-onnx-moonshine-base-en-quantized-2026-02-27": {
        "languageLane": "en",
        "disposition": "REJECTED_RUNTIME_MODEL_FORMAT",
        "failureCode": "ORT_PROTOBUF_PARSE_FAILED",
    },
}


class M4MatrixError(RuntimeError):
    pass


def _rank_eligible_fixture_role(role: str) -> bool:
    return role in {"development", "held_out"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise M4MatrixError(message)


def load_registries(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    base = json.loads((root / "candidates.json").read_text(encoding="utf-8"))
    expansion = json.loads(
        (root / "expanded_candidates_m4.json").read_text(encoding="utf-8")
    )
    validate_expansion(expansion, base)
    return base, expansion


def resolve_candidate(
    candidate_id: str,
    *,
    base: dict[str, Any],
    expansion: dict[str, Any],
) -> dict[str, Any]:
    base_candidates = {
        candidate["candidateId"]: candidate for candidate in base["candidates"]
    }
    new_candidates = {
        candidate["candidateId"]: candidate
        for candidate in expansion["newCandidates"]
    }
    overrides = {
        candidate["candidateId"]: candidate
        for candidate in expansion["candidateOverrides"]
    }
    if candidate_id in new_candidates:
        return new_candidates[candidate_id]
    require(candidate_id in base_candidates, f"unknown candidate: {candidate_id}")
    candidate = dict(base_candidates[candidate_id])
    if candidate_id in overrides:
        candidate.update(overrides[candidate_id])
    return candidate


def language_candidates(
    language_lane: str,
    requested: tuple[str, ...] | None = None,
) -> tuple[str, ...]:
    require(language_lane in LANGUAGE_CANDIDATES, "unknown language lane")
    frozen = LANGUAGE_CANDIDATES[language_lane]
    if requested is None:
        return frozen
    unknown = set(requested) - set(frozen)
    require(not unknown, f"candidate is outside the frozen {language_lane} lane")
    return tuple(candidate for candidate in frozen if candidate in requested)


def worker_artifacts(candidate: dict[str, Any]) -> dict[str, str]:
    artifacts = candidate["artifacts"]
    if isinstance(artifacts, dict):
        return dict(artifacts)
    by_component = {
        artifact["componentId"]: artifact["sha256"]
        for artifact in artifacts
        if artifact["componentId"]
        not in {"archive", "repository-bundle", "tokenizer-json", "tokenizer-merges", "tokenizer-vocab"}
    }
    family = candidate["family"]
    roles = {
        "streaming_zipformer_transducer": ("encoder", "decoder", "joiner", "tokens"),
        "offline_paraformer": ("model", "tokens"),
        "firered_asr_ctc": ("model", "tokens"),
    }.get(family)
    require(roles is not None, f"base artifacts unsupported for {family}")
    require(set(roles) <= set(by_component), "candidate artifact roles are incomplete")
    return {role: by_component[role] for role in roles}


def profile_for(
    candidate: dict[str, Any],
    *,
    language_lane: str,
    profile_id: str,
) -> dict[str, Any]:
    profiles = candidate.get("profiles")
    if (
        isinstance(profiles, dict)
        and profile_id in profiles
        and candidate["family"] == "offline_paraformer"
    ):
        return dict(profiles[profile_id]["effectiveConfig"])
    return effective_config(
        candidate["family"],
        language_lane=language_lane,
        profile_id=profile_id,
    )


def _fixture_entries(manifest: dict[str, Any], role: str) -> list[dict[str, Any]]:
    fixtures = [
        fixture
        for fixture in manifest["fixtures"]
        if fixture["fixtureRole"] == role
    ]
    require(fixtures, f"fixture manifest has no {role} entries")
    return fixtures


def _model_files(
    *,
    candidate: dict[str, Any],
    model_root: Path,
) -> dict[str, dict[str, str]]:
    candidate_root = model_root / candidate["candidateId"]
    expected = worker_artifacts(candidate)
    result: dict[str, dict[str, str]] = {}
    for role, expected_hash in expected.items():
        path = candidate_root / role
        require(path.exists(), f"{candidate['candidateId']}: model role missing: {role}")
        actual_hash = (
            _tokenizer_tree_hash(path)
            if role == "tokenizer"
            else sha256_file(path)
        )
        require(
            actual_hash == expected_hash,
            f"{candidate['candidateId']}: model hash mismatch: {role}",
        )
        result[role] = {"path": str(path), "sha256": actual_hash}
    return result


def _job_model_files(
    model_files: dict[str, dict[str, str]],
    *,
    job_root: Path,
) -> dict[str, dict[str, str]]:
    alias_root = job_root / "models"
    aliases: dict[str, dict[str, str]] = {}
    for role, model in model_files.items():
        source = Path(model["path"])
        if source.is_dir() or role in {"tokens", "tokenizer"}:
            aliases[role] = dict(model)
            continue
        alias_root.mkdir(parents=True, exist_ok=True)
        alias = alias_root / f"{role}.onnx"
        alias.symlink_to(source)
        aliases[role] = {"path": str(alias), "sha256": model["sha256"]}
    return aliases


def run_matrix(args: argparse.Namespace) -> dict[str, Any]:
    comparison_root = Path(__file__).resolve().parent
    base, expansion = load_registries(comparison_root)
    model_root = args.model_root.resolve()
    runtime_root = args.runtime_root.resolve()
    tools_root = args.tools_root.resolve()
    fixture_root = args.fixture_root.resolve()
    output_root = args.output_root.resolve()
    manifest_path = fixture_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(
        manifest["languageLane"] == args.language_lane,
        "fixture language lane mismatch",
    )
    fixtures = _fixture_entries(manifest, args.fixture_role)
    requested = tuple(args.candidate) if args.candidate else None
    candidate_ids = language_candidates(args.language_lane, requested)
    require(candidate_ids, "matrix candidate set is empty")
    runtime = runtime_root / "libsherpa-onnx-c-api.dylib"
    launcher = tools_root / "sandboxed_candidate_launcher"
    worker = tools_root / "desktop_asr_candidate_worker"
    process_group = tools_root / "native_process_group_launcher"
    for path in (runtime, launcher, worker, process_group):
        require(path.is_file(), f"required runtime/tool missing: {path.name}")
    profile_id = args.profile_id
    matrix: list[dict[str, Any]] = []
    resolved_candidates: dict[str, dict[str, Any]] = {}
    profiles: dict[str, dict[str, Any]] = {}
    model_files: dict[str, dict[str, dict[str, str]]] = {}
    for candidate_id in candidate_ids:
        candidate = resolve_candidate(
            candidate_id, base=base, expansion=expansion
        )
        resolved_candidates[candidate_id] = candidate
        profiles[candidate_id] = profile_for(
            candidate,
            language_lane=args.language_lane,
            profile_id=profile_id,
        )
        model_files[candidate_id] = _model_files(
            candidate=candidate,
            model_root=model_root,
        )
        for fixture in fixtures:
            matrix.append(
                {
                    "candidateId": candidate_id,
                    "profileId": profile_id,
                    "fixtureId": fixture["fixtureId"],
                    "laneId": RUNTIME_LANE,
                    "scorecard": (
                        "core_asr"
                        if profile_id == "fixed-resource"
                        else "end_to_end"
                    ),
                    "scenario": fixture["scenario"],
                    "rankEligible": _rank_eligible_fixture_role(
                        args.fixture_role
                    ),
                    "observationSource": f"m4_{args.stage}_real_authorized",
                    "pacingPolicy": profiles[candidate_id].get(
                        "pacingPolicy", "unpaced"
                    ),
                }
            )
    schedule = deterministic_schedule(
        matrix,
        seed=args.seed,
        warmup_runs=args.warmup_runs,
        measured_runs=args.measured_runs,
    )
    run_root = output_root / "runs"
    raw_root = output_root / "raw"
    records: list[dict[str, Any]] = []
    fixture_index = {fixture["fixtureId"]: fixture for fixture in fixtures}
    for scheduled in schedule:
        candidate_id = scheduled["candidateId"]
        fixture = fixture_index[scheduled["fixtureId"]]
        source_fixture = fixture_root / fixture["audioRelativePath"]
        reference_path = fixture_root / fixture["referenceRelativePath"]
        require(
            sha256_file(source_fixture) == fixture["audioSha256"]
            and sha256_file(reference_path) == fixture["referenceSha256"],
            f"{fixture['fixtureId']}: fixture hash mismatch",
        )
        job_root = (
            output_root
            / "jobs"
            / f"{scheduled['scheduleOrder']:05d}-{candidate_id}-{fixture['fixtureId']}"
        )
        if job_root.exists():
            shutil.rmtree(job_root)
        input_root = job_root / "input"
        input_root.mkdir(parents=True)
        source = input_root / "audio.wav"
        shutil.copyfile(source_fixture, source)
        job_model_files = _job_model_files(
            model_files[candidate_id],
            job_root=job_root,
        )
        profile = profiles[candidate_id]
        candidate = resolved_candidates[candidate_id]
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
                "candidateId": candidate_id,
                "family": candidate["family"],
                "profileId": profile_id,
                "sourcePath": str(source),
                "sourceSha256": sha256_file(source),
                "modelFiles": job_model_files,
                "effectiveConfig": profile,
                "capabilities": _capabilities(candidate["family"]),
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
            "contractSha256": sha256_file(comparison_root / "macos_contract.json"),
            "candidateRegistrySha256": sha256_file(
                comparison_root / "expanded_candidates_m4.json"
            ),
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
        timeout_seconds = max(
            args.timeout_seconds,
            fixture["durationSeconds"]
            * (1.5 if profile.get("pacingPolicy") == "realtime_audio_clock" else 0.75)
            + 180,
        )
        try:
            records.append(
                execute_run(
                    command=[str(launcher)],
                    request=request,
                    specification=specification,
                    binding=binding,
                    run_root=run_root,
                    raw_root=raw_root,
                    timeout_seconds=timeout_seconds,
                    sampler_interval_seconds=0.02,
                )
            )
        finally:
            shutil.rmtree(job_root, ignore_errors=True)
    aggregates = []
    for candidate_id in candidate_ids:
        candidate_records = [
            record for record in records if record["candidateId"] == candidate_id
        ]
        aggregates.append(aggregate_candidate(candidate_records))
    summary = {
        "schemaVersion": 1,
        "kind": "m4_asr_real_matrix",
        "stage": args.stage,
        "languageLane": args.language_lane,
        "lexicalMetric": "cer" if args.language_lane == "zh" else "wer",
        "fixtureRole": args.fixture_role,
        "profileId": profile_id,
        "warmupRuns": args.warmup_runs,
        "measuredRuns": args.measured_runs,
        "candidateIds": list(candidate_ids),
        "fixtureManifestSha256": sha256_file(manifest_path),
        "measurementContractRevision": "m4-zh-en-measurement-v1",
        "aggregates": aggregates,
        "observations": [
            {
                "runId": record["runId"],
                "candidateId": record["candidateId"],
                "profileId": record["profileId"],
                "fixtureId": record["fixtureId"],
                "scenario": record["scenario"],
                "runIndex": record["runIndex"],
                "warmup": record["warmup"],
                "scheduleOrder": record["scheduleOrder"],
                "rawOutputSha256": record["rawOutputSha256"],
                "metrics": record["metrics"],
                "resources": record["resources"],
                "streamingObservation": record["streamingObservation"],
            }
            for record in records
        ],
        "runtimeRejections": list(RUNTIME_REJECTIONS.values()),
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--language-lane", choices=("zh", "en"), required=True)
    parser.add_argument(
        "--fixture-role",
        choices=(
            "stability",
            "development",
            "held_out",
            "streaming",
            "operational",
        ),
        required=True,
    )
    parser.add_argument(
        "--profile-id",
        choices=("fixed-resource", "recommended"),
        default="fixed-resource",
    )
    parser.add_argument("--candidate", action="append")
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--tools-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--measured-runs", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        summary = run_matrix(args)
    except (
        OSError,
        json.JSONDecodeError,
        M4MatrixError,
        OrchestrationError,
    ) as error:
        print(f"M4 ASR matrix: FAIL: {error}")
        return 1
    print(
        json.dumps(
            {
                "stage": summary["stage"],
                "languageLane": summary["languageLane"],
                "candidateCount": len(summary["candidateIds"]),
                "aggregateCount": len(summary["aggregates"]),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
