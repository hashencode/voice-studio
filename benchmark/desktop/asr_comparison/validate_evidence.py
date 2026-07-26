#!/usr/bin/env python3
"""Validate and atomically publish bounded, privacy-safe comparison-v2 evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


SCHEMA_VERSION = 2
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 5 * 1024 * 1024
MAX_DEPTH = 12
MAX_LIST_ITEMS = 2048
MAX_STRING_CHARACTERS = 2048
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_RELATIVE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
FORBIDDEN_FIELDS = {
    "audio",
    "audiopayload",
    "pcm",
    "pcmpayload",
    "transcript",
    "hypothesis",
    "reference",
    "referencetext",
    "text",
    "tokens",
    "embedding",
    "embeddings",
    "voiceprint",
    "voiceprints",
    "secret",
    "password",
    "token",
    "apikey",
    "authorization",
    "cookie",
    "speakername",
    "personname",
    "privatelabel",
    "sourcepath",
    "absolutepath",
}
PUBLICATION_BINDING_KEYS = {
    "contractSha256",
    "candidateRegistrySha256",
    "scoringContractSha256",
    "runtimeSha256",
    "workerSha256",
    "modelComponentsSha256",
    "profileSha256",
    "fixtureSha256",
    "referenceSha256",
    "targetFingerprintSha256",
}
ALLOWED_DISPOSITIONS = {
    "SUCCESS",
    "CRASH",
    "TIMEOUT",
    "OOM",
    "INVALID_INPUT",
    "MALFORMED_OUTPUT",
    "OUTPUT_BOUND",
    "CANCELLED",
    "SANDBOX_DENIED",
}
DOCUMENT_KINDS = {"runSet", "aggregate", "reliability"}


class EvidenceValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceValidationError(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def sha256_file(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def _validate_bounds_and_privacy(value: Any, location: str = "$", depth: int = 0) -> None:
    require(depth <= MAX_DEPTH, f"{location}: nesting exceeds {MAX_DEPTH}")
    if isinstance(value, dict):
        require(len(value) <= MAX_LIST_ITEMS, f"{location}: object is oversized")
        for key, child in value.items():
            require(
                isinstance(key, str) and 0 < len(key) <= 128,
                f"{location}: invalid field name",
            )
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            require(
                normalized not in FORBIDDEN_FIELDS,
                f"{location}: forbidden private field {key}",
            )
            _validate_bounds_and_privacy(child, f"{location}.{key}", depth + 1)
    elif isinstance(value, list):
        require(
            len(value) <= MAX_LIST_ITEMS,
            f"{location}: list exceeds {MAX_LIST_ITEMS} items",
        )
        for index, child in enumerate(value):
            _validate_bounds_and_privacy(child, f"{location}[{index}]", depth + 1)
    elif isinstance(value, str):
        require(
            len(value) <= MAX_STRING_CHARACTERS,
            f"{location}: string is oversized",
        )
        require(
            not value.startswith(("/", "~"))
            and re.match(r"^[A-Za-z]:[\\/]", value) is None
            and "/Users/" not in value
            and "\\Users\\" not in value,
            f"{location}: absolute or user-home path is forbidden",
        )
    elif isinstance(value, float):
        require(math.isfinite(value), f"{location}: non-finite number")
    else:
        require(
            value is None or isinstance(value, (bool, int)),
            f"{location}: unsupported JSON value",
        )


def _validate_bindings(value: Any, location: str) -> None:
    require(isinstance(value, dict), f"{location}: publication bindings missing")
    require(
        set(value) == PUBLICATION_BINDING_KEYS,
        f"{location}: publication binding fields mismatch",
    )
    for key, digest in value.items():
        require(_is_sha256(digest), f"{location}.{key}: invalid SHA-256")


def _validate_metrics(value: Any, location: str) -> None:
    require(isinstance(value, dict) and value, f"{location}: metrics missing")
    for key, metric in value.items():
        require(isinstance(key, str) and key, f"{location}: metric key invalid")
        require(
            metric is None
            or (
                isinstance(metric, (int, float))
                and not isinstance(metric, bool)
                and math.isfinite(metric)
            ),
            f"{location}.{key}: metric must be finite or null",
        )


def _validate_run_set(document: dict[str, Any]) -> dict[str, str]:
    required = {
        "schemaVersion",
        "kind",
        "evidenceClass",
        "rankEligible",
        "targetFingerprintSha256",
        "publicationBindings",
        "runs",
    }
    require(set(document) == required, "runSet: fields mismatch")
    require(document["rankEligible"] is False, "smoke runs cannot be rank eligible")
    require(_is_sha256(document["targetFingerprintSha256"]), "runSet: target hash")
    _validate_bindings(document["publicationBindings"], "runSet")
    runs = document["runs"]
    require(isinstance(runs, list) and runs, "runSet: runs missing")
    required_run = {
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
    }
    run_ids: set[str] = set()
    measured = 0
    warmups = 0
    for run in runs:
        require(isinstance(run, dict), "runSet: run must be an object")
        require(set(run) == required_run, "runSet: run fields mismatch")
        run_id = run["runId"]
        require(
            isinstance(run_id, str)
            and re.fullmatch(r"asr2-[0-9a-f]{32}", run_id) is not None,
            "runSet: invalid run id",
        )
        require(run_id not in run_ids, "runSet: duplicate run id")
        run_ids.add(run_id)
        require(run["complete"] is True, f"{run_id}: incomplete")
        require(run["disposition"] == "SUCCESS", f"{run_id}: unsuccessful")
        require(run["rankEligible"] is False, f"{run_id}: rank eligibility")
        require(
            run["observationSource"] == "fake_worker_contract_smoke",
            f"{run_id}: source mismatch",
        )
        require(_is_sha256(run["bindingSha256"]), f"{run_id}: binding hash")
        require(_is_sha256(run["rawOutputSha256"]), f"{run_id}: output hash")
        require(
            run["temporaryArtifactsReleased"] is True,
            f"{run_id}: temporary artifacts leaked",
        )
        require(
            isinstance(run["runIndex"], int)
            and isinstance(run["scheduleOrder"], int),
            f"{run_id}: schedule fields",
        )
        require(isinstance(run["warmup"], bool), f"{run_id}: warmup flag")
        warmups += run["warmup"]
        measured += not run["warmup"]
        _validate_metrics(run["metrics"], f"{run_id}.metrics")
        resources = run["resources"]
        require(isinstance(resources, dict), f"{run_id}: resources missing")
        for key in (
            "absolutePeakRssBytes",
            "incrementalPeakRssBytes",
            "retainedRssBytesAfterUnload",
            "cpuUserSeconds",
            "cpuSystemSeconds",
            "temporaryDiskPeakBytes",
        ):
            value = resources.get(key)
            require(
                value is None
                or (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(value)
                    and value >= 0
                ),
                f"{run_id}.{key}: resource value invalid",
            )
    require(warmups == 1 and measured == 5, "runSet: expected one warmup and five measured")
    return {
        run["runId"]: run["rawOutputSha256"]
        for run in runs
    }


def _validate_aggregate(
    document: dict[str, Any], run_output_hashes: dict[str, str]
) -> None:
    required = {
        "schemaVersion",
        "kind",
        "evidenceClass",
        "rankEligible",
        "targetFingerprintSha256",
        "publicationBindings",
        "aggregate",
    }
    require(set(document) == required, "aggregate document: fields mismatch")
    require(document["rankEligible"] is False, "aggregate cannot be rank eligible")
    require(_is_sha256(document["targetFingerprintSha256"]), "aggregate: target hash")
    _validate_bindings(document["publicationBindings"], "aggregate")
    aggregate = document["aggregate"]
    require(isinstance(aggregate, dict), "aggregate payload missing")
    require(aggregate.get("schemaVersion") == SCHEMA_VERSION, "aggregate schema")
    require(aggregate.get("rankEligible") is False, "aggregate rank eligibility")
    require(
        aggregate.get("observationSource") == "fake_worker_contract_smoke",
        "aggregate source",
    )
    require(aggregate.get("measuredRunCount") == 5, "aggregate measured count")
    aggregate_runs = aggregate.get("runs")
    require(isinstance(aggregate_runs, list), "aggregate runs missing")
    require(
        {run.get("runId") for run in aggregate_runs} == set(run_output_hashes),
        "aggregate run identities do not match runSet",
    )
    require(
        all(
            run.get("rawOutputSha256")
            == run_output_hashes.get(run.get("runId"))
            for run in aggregate_runs
        ),
        "aggregate raw-output hash does not match runSet",
    )
    require(
        aggregate.get("aggregationPolicy")
        == {
            "warmupsExcluded": True,
            "scenarioMacroEqualWeight": True,
            "durationWeighted": False,
        },
        "aggregate policy changed",
    )


def _validate_reliability(document: dict[str, Any]) -> None:
    required = {
        "schemaVersion",
        "kind",
        "evidenceClass",
        "rankEligible",
        "targetFingerprintSha256",
        "publicationBindings",
        "probes",
        "determinism",
        "hallucination",
        "longRunPolicy",
        "rankedExecutionPrerequisites",
    }
    require(set(document) == required, "reliability: fields mismatch")
    require(document["rankEligible"] is False, "reliability cannot be ranked")
    require(_is_sha256(document["targetFingerprintSha256"]), "reliability: target")
    _validate_bindings(document["publicationBindings"], "reliability")
    probes = document["probes"]
    require(isinstance(probes, list) and probes, "reliability probes missing")
    probe_ids: set[str] = set()
    required_probe = {"probeId", "outcome", "disposition", "details"}
    for probe in probes:
        require(isinstance(probe, dict), "reliability probe invalid")
        require(set(probe) == required_probe, "reliability probe fields mismatch")
        probe_id = probe["probeId"]
        require(
            isinstance(probe_id, str)
            and re.fullmatch(r"[a-z0-9_-]+", probe_id) is not None,
            "reliability probe id invalid",
        )
        require(probe_id not in probe_ids, "duplicate reliability probe")
        probe_ids.add(probe_id)
        require(probe["outcome"] == "PASS", f"{probe_id}: probe did not pass")
        require(
            probe["disposition"] in ALLOWED_DISPOSITIONS,
            f"{probe_id}: unknown disposition",
        )
        require(
            isinstance(probe["details"], dict)
            and set(probe["details"]).issubset(
                {
                    "processGroupGone",
                    "descendantProcessesGone",
                    "temporaryArtifactsReleased",
                    "atomicActivation",
                    "networkPermissionDenied",
                    "userHomePermissionDenied",
                    "durationSeconds",
                    "outputCharacters",
                }
            ),
            f"{probe_id}: undeclared diagnostic payload",
        )
    required_probes = {
        "crash",
        "timeout",
        "oom",
        "empty_output",
        "malformed_output",
        "malformed_input",
        "short_input",
        "silent_input",
        "deterministic_repeat",
        "term_resistant_cancellation",
        "temporary_cleanup",
        "sandbox_denial",
        "atomic_publication",
    }
    require(required_probes.issubset(probe_ids), "required reliability probes missing")
    determinism = document["determinism"]
    require(
        isinstance(determinism, dict)
        and set(determinism)
        == {"seed", "repeatedRuns", "distinctRawOutputCount", "stable"}
        and determinism["repeatedRuns"] >= 2
        and determinism["distinctRawOutputCount"] == 1
        and determinism["stable"] is True,
        "seeded determinism evidence is invalid",
    )
    hallucination = document["hallucination"]
    require(
        isinstance(hallucination, dict)
        and set(hallucination)
        == {"fixtureId", "lexicalCharactersPerMinute"}
        and isinstance(hallucination["lexicalCharactersPerMinute"], (int, float))
        and math.isfinite(hallucination["lexicalCharactersPerMinute"])
        and hallucination["lexicalCharactersPerMinute"] >= 0,
        "hallucination observation is invalid",
    )
    long_policy = document["longRunPolicy"]
    require(
        long_policy
        == {
            "executed": False,
            "repeatWithinLimitFraction": 0.1,
            "scope": "tooling_only_U7_U8_not_executed",
        },
        "long-run boundary changed",
    )
    prerequisites = document["rankedExecutionPrerequisites"]
    require(
        isinstance(prerequisites, list)
        and len(prerequisites) >= 3
        and all(isinstance(item, str) and item for item in prerequisites),
        "ranked execution prerequisites missing",
    )


def long_run_repeat_required(
    metrics: dict[str, float],
    limits: dict[str, float],
    *,
    fraction: float = 0.1,
) -> bool:
    require(0 < fraction < 1 and math.isfinite(fraction), "repeat fraction invalid")
    require(set(metrics) == set(limits) and metrics, "metric/limit keys mismatch")
    for key, limit in limits.items():
        metric = metrics[key]
        require(
            isinstance(metric, (int, float))
            and not isinstance(metric, bool)
            and math.isfinite(metric)
            and isinstance(limit, (int, float))
            and not isinstance(limit, bool)
            and math.isfinite(limit)
            and limit > 0,
            f"{key}: invalid long-run metric or limit",
        )
        if abs(float(limit) - float(metric)) / float(limit) <= fraction:
            return True
    return False


def validate_evidence_tree(root: Path) -> dict[str, Any]:
    root = root.resolve(strict=True)
    index_path = root / "index.json"
    require(index_path.is_file(), "evidence index is missing")
    require(index_path.stat().st_size <= MAX_FILE_BYTES, "index is oversized")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    require(isinstance(index, dict), "index root must be an object")
    _validate_bounds_and_privacy(index)
    required_index = {
        "schemaVersion",
        "evidenceSetId",
        "contractId",
        "evidenceClass",
        "rankEligible",
        "targetFingerprint",
        "targetFingerprintSha256",
        "publicationBindings",
        "entries",
    }
    require(set(index) == required_index, "index fields mismatch")
    require(index["schemaVersion"] == SCHEMA_VERSION, "index schema")
    require(
        index["contractId"] == "desktop-processing/macos-asr-comparison-v2",
        "index contract",
    )
    require(
        index["evidenceClass"] == "non_ranked_smoke"
        and index["rankEligible"] is False,
        "index evidence class",
    )
    target = index["targetFingerprint"]
    require(
        isinstance(target, dict)
        and set(target)
        == {
            "operatingSystem",
            "operatingSystemVersion",
            "architecture",
            "cpuModel",
            "logicalCpuCount",
            "memoryBytes",
            "runtimeId",
            "runtimeVersion",
            "runtimeSha256",
        },
        "target fingerprint fields mismatch",
    )
    require(target["operatingSystem"] == "macos", "target is not macOS")
    require(target["architecture"] in {"arm64", "x86_64"}, "target architecture")
    require(_is_sha256(target["runtimeSha256"]), "target runtime hash")
    target_hash = hashlib.sha256(canonical_json(target)).hexdigest()
    require(
        index["targetFingerprintSha256"] == target_hash,
        "target fingerprint hash mismatch",
    )
    _validate_bindings(index["publicationBindings"], "index")
    require(
        index["publicationBindings"]["targetFingerprintSha256"] == target_hash,
        "index target binding mismatch",
    )
    entries = index["entries"]
    require(
        isinstance(entries, list) and 1 <= len(entries) <= 512,
        "index entries invalid",
    )
    entry_fields = {"path", "kind", "sha256", "bytes"}
    paths: set[str] = set()
    documents: dict[str, dict[str, Any]] = {}
    total_bytes = index_path.stat().st_size
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == entry_fields, "entry fields")
        relative = entry["path"]
        require(
            isinstance(relative, str)
            and SAFE_RELATIVE_PATH.fullmatch(relative) is not None
            and PurePosixPath(relative).is_absolute() is False
            and ".." not in PurePosixPath(relative).parts,
            "entry path is unsafe",
        )
        require(relative not in paths and relative != "index.json", "duplicate entry")
        paths.add(relative)
        require(entry["kind"] in DOCUMENT_KINDS, "unknown document kind")
        source = root / relative
        require(source.is_file(), f"missing evidence file: {relative}")
        resolved = source.resolve(strict=True)
        require(resolved.is_relative_to(root), f"evidence path escapes root: {relative}")
        size = source.stat().st_size
        require(0 < size <= MAX_FILE_BYTES, f"{relative}: file size invalid")
        require(entry["bytes"] == size, f"{relative}: byte count mismatch")
        require(_is_sha256(entry["sha256"]), f"{relative}: hash invalid")
        require(entry["sha256"] == sha256_file(source), f"{relative}: hash mismatch")
        total_bytes += size
        document = json.loads(source.read_text(encoding="utf-8"))
        require(isinstance(document, dict), f"{relative}: root must be object")
        _validate_bounds_and_privacy(document)
        require(document.get("schemaVersion") == SCHEMA_VERSION, f"{relative}: schema")
        require(document.get("kind") == entry["kind"], f"{relative}: kind mismatch")
        require(
            document.get("evidenceClass") == index["evidenceClass"]
            and document.get("targetFingerprintSha256") == target_hash
            and document.get("publicationBindings") == index["publicationBindings"],
            f"{relative}: publication binding mismatch",
        )
        documents[entry["kind"]] = document
    require(total_bytes <= MAX_TOTAL_BYTES, "evidence tree is oversized")
    actual_files = {
        str(path.relative_to(root))
        for path in root.rglob("*")
        if path.is_file()
    }
    require(actual_files == paths | {"index.json"}, "unindexed evidence file")
    require(set(documents) == DOCUMENT_KINDS, "required evidence documents missing")
    run_output_hashes = _validate_run_set(documents["runSet"])
    _validate_aggregate(documents["aggregate"], run_output_hashes)
    _validate_reliability(documents["reliability"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "PASS",
        "fileCount": len(entries) + 1,
        "totalBytes": total_bytes,
        "indexSha256": sha256_file(index_path),
    }


def publish_atomically(source_root: Path, publication_root: Path) -> dict[str, Any]:
    """Validate staging, then atomically point active at a content-addressed version."""
    validation = validate_evidence_tree(source_root)
    publication_root.mkdir(parents=True, exist_ok=True)
    versions = publication_root / "versions"
    versions.mkdir(exist_ok=True)
    version_id = validation["indexSha256"]
    version = versions / version_id
    staging = publication_root / f".staging-{os.getpid()}-{version_id[:12]}"
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(source_root, staging)
    validate_evidence_tree(staging)
    if version.exists():
        shutil.rmtree(staging)
    else:
        os.replace(staging, version)
    temporary_link = publication_root / f".active-{os.getpid()}.tmp"
    temporary_link.symlink_to(Path("versions") / version_id)
    os.replace(temporary_link, publication_root / "active")
    active = publication_root / "active"
    require(active.resolve() == version.resolve(), "atomic activation failed")
    result = validate_evidence_tree(active)
    return {**result, "versionId": version_id, "atomicActivation": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-root", required=True, type=Path)
    parser.add_argument("--publish-root", type=Path)
    args = parser.parse_args()
    try:
        result = (
            publish_atomically(args.evidence_root, args.publish_root)
            if args.publish_root is not None
            else validate_evidence_tree(args.evidence_root)
        )
    except (
        EvidenceValidationError,
        OSError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
    ) as error:
        print(f"comparison-v2 evidence invalid: {error}")
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
