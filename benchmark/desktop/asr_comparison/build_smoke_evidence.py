#!/usr/bin/env python3
"""Build sanitized, non-ranked smoke evidence from hash-valid local U5 runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from aggregate_results import aggregate_candidate
    from reliability_probes import run_reliability_probes
    from run_macos_asr_comparison import canonical_json, sha256_file
    from validate_evidence import publish_atomically, validate_evidence_tree
except ModuleNotFoundError:
    from benchmark.desktop.asr_comparison.aggregate_results import aggregate_candidate
    from benchmark.desktop.asr_comparison.reliability_probes import (
        run_reliability_probes,
    )
    from benchmark.desktop.asr_comparison.run_macos_asr_comparison import (
        canonical_json,
        sha256_file,
    )
    from benchmark.desktop.asr_comparison.validate_evidence import (
        publish_atomically,
        validate_evidence_tree,
    )


def _atomic_json(destination: Path, value: Any) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(
            value,
            stream,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, destination)


def _system_value(name: str, fallback: str) -> str:
    try:
        return subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", name],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return fallback


def _target_fingerprint(runtime_sha256: str) -> dict[str, Any]:
    memory_text = _system_value("hw.memsize", str(4 * 1024**3))
    return {
        "operatingSystem": "macos",
        "operatingSystemVersion": platform.mac_ver()[0] or "unknown",
        "architecture": platform.machine(),
        "cpuModel": _system_value("machdep.cpu.brand_string", "unknown"),
        "logicalCpuCount": os.cpu_count() or 1,
        "memoryBytes": int(memory_text),
        "runtimeId": "python-fake-contract-smoke",
        "runtimeVersion": platform.python_version(),
        "runtimeSha256": runtime_sha256,
    }


def _public_run(run: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "runId",
        "complete",
        "disposition",
        "rankEligible",
        "observationSource",
        "candidateId",
        "laneId",
        "profileId",
        "fixtureId",
        "scenario",
        "scorecard",
        "runIndex",
        "warmup",
        "scheduleOrder",
        "bindingSha256",
        "rawOutputSha256",
        "metrics",
        "resources",
        "streamingObservation",
        "temporaryArtifactsReleased",
    )
    return {key: run[key] for key in keys}


def _safe_output_root(repository_root: Path, requested: Path) -> Path:
    requested = requested if requested.is_absolute() else repository_root / requested
    require_name = requested.name not in {"", ".", ".."}
    if not require_name or requested.is_symlink():
        raise ValueError("smoke evidence output is unsafe")
    resolved = requested.parent.resolve() / requested.name
    allowed = (
        repository_root / "build/desktop_asr_comparison",
        repository_root / "benchmark/desktop/evidence/macos-asr-comparison-v2",
    )
    if not any(resolved.is_relative_to(root.resolve()) for root in allowed):
        raise ValueError("smoke evidence output must stay in a managed evidence root")
    return resolved


def build_smoke_evidence(repository_root: Path, output_root: Path) -> dict[str, Any]:
    repository_root = repository_root.resolve(strict=True)
    output_root = _safe_output_root(repository_root, output_root)
    output_root.parent.mkdir(parents=True, exist_ok=True)
    comparison_root = repository_root / "benchmark/desktop/asr_comparison"
    run_root = repository_root / "build/desktop_asr_comparison/runs"
    fixture_root = (
        repository_root / "build/desktop_asr_comparison/fixtures/active/fixtures"
    )
    worker = comparison_root / "test_support/fake_candidate_worker.py"
    audio = fixture_root / "committed-zh-300s.wav"
    reference = fixture_root / "committed-zh-300s.txt"
    profile = {
        "modelFamily": "fake_contract_smoke",
        "provider": "cpu",
        "numThreads": 2,
        "concurrency": 1,
        "inputMode": "frozen_segments",
        "pacingPolicy": "unpaced",
    }
    expected = {
        "contractSha256": sha256_file(comparison_root / "macos_contract.json"),
        "candidateRegistrySha256": sha256_file(
            comparison_root / "candidates.json"
        ),
        "scoringContractSha256": sha256_file(
            comparison_root / "scoring_contract.json"
        ),
        "scorerSha256": sha256_file(comparison_root / "asr_scoring.py"),
        "runtimeSha256": sha256_file(Path(sys.executable)),
        "workerSha256": sha256_file(worker),
        "fixtureSha256": sha256_file(audio),
        "referenceSha256": sha256_file(reference),
        "profileSha256": hashlib.sha256(canonical_json(profile)).hexdigest(),
    }
    selected: list[dict[str, Any]] = []
    for source in sorted(run_root.glob("asr2-*.json")):
        run = json.loads(source.read_text(encoding="utf-8"))
        if (
            run.get("complete") is True
            and run.get("observationSource") == "fake_worker_contract_smoke"
            and run.get("bindings") == expected
        ):
            selected.append(_public_run(run))
    selected.sort(key=lambda run: (run["scheduleOrder"], run["runId"]))
    if len(selected) != 6:
        raise ValueError(
            "exactly six current hash-bound fake smoke runs are required; "
            "rerun run_macos_asr_comparison.py --fake-smoke"
        )
    aggregate = aggregate_candidate(selected)
    aggregate.update(
        {
            "rankEligible": False,
            "observationSource": "fake_worker_contract_smoke",
            "purpose": "orchestrator_scorer_aggregator_vertical_validation",
        }
    )
    target = _target_fingerprint(expected["runtimeSha256"])
    target_hash = hashlib.sha256(canonical_json(target)).hexdigest()
    publication_bindings = {
        **expected,
        "modelComponentsSha256": hashlib.sha256(canonical_json({})).hexdigest(),
        "targetFingerprintSha256": target_hash,
    }
    reliability = run_reliability_probes(repository_root)
    common = {
        "schemaVersion": 2,
        "evidenceClass": "non_ranked_smoke",
        "rankEligible": False,
        "targetFingerprintSha256": target_hash,
        "publicationBindings": publication_bindings,
    }
    documents = {
        "runs.json": {
            **common,
            "kind": "runSet",
            "runs": selected,
        },
        "aggregate.json": {
            **common,
            "kind": "aggregate",
            "aggregate": aggregate,
        },
        "reliability.json": {
            **common,
            "kind": "reliability",
            "probes": reliability["probes"],
            "determinism": reliability["determinism"],
            "hallucination": reliability["hallucination"],
            "longRunPolicy": {
                "executed": False,
                "repeatWithinLimitFraction": 0.1,
                "scope": "tooling_only_U7_U8_not_executed",
            },
            "rankedExecutionPrerequisites": [
                "provision every frozen candidate artifact and approve licenses",
                "prepare reviewed development and held-out local fixture packs",
                "freeze profiles and target before any held-out decode",
                "run Stage 0 admission and the development-only pilot",
                "execute U7 and U8 only after the preceding conditions pass",
            ],
        },
    }
    staging = output_root.parent / f".{output_root.name}.staging-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    entries = []
    for name, document in documents.items():
        destination = staging / name
        _atomic_json(destination, document)
        entries.append(
            {
                "path": name,
                "kind": document["kind"],
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
            }
        )
    index = {
        "schemaVersion": 2,
        "evidenceSetId": "macos-asr-comparison-v2-smoke",
        "contractId": "desktop-processing/macos-asr-comparison-v2",
        "evidenceClass": "non_ranked_smoke",
        "rankEligible": False,
        "targetFingerprint": target,
        "targetFingerprintSha256": target_hash,
        "publicationBindings": publication_bindings,
        "entries": entries,
    }
    _atomic_json(staging / "index.json", index)
    validate_evidence_tree(staging)
    if output_root.exists():
        backup = output_root.parent / f".{output_root.name}.previous-{os.getpid()}"
        if backup.exists():
            raise ValueError("smoke evidence activation backup already exists")
        os.replace(output_root, backup)
        try:
            os.replace(staging, output_root)
        except BaseException:
            os.replace(backup, output_root)
            raise
        shutil.rmtree(backup)
    else:
        os.replace(staging, output_root)
    return validate_evidence_tree(output_root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publication-root", type=Path)
    args = parser.parse_args()
    result = build_smoke_evidence(args.root, args.output)
    if args.publication_root is not None:
        result["publication"] = publish_atomically(
            args.output, args.publication_root
        )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
