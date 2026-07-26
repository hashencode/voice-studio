#!/usr/bin/env python3
"""Plan and atomically verify local model assets for comparison-v2 workers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


HEX64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class AssetError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssetError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def asset_plan(registry: dict[str, Any]) -> dict[str, Any]:
    candidates = registry.get("candidates")
    require(isinstance(candidates, list), "candidate registry is missing")
    plan = []
    for candidate in candidates:
        artifacts = candidate.get("artifacts")
        require(isinstance(artifacts, list) and artifacts, "candidate artifacts missing")
        pinned = all(
            isinstance(artifact, dict)
            and HEX64.fullmatch(str(artifact.get("sha256", ""))) is not None
            and artifact.get("hashState") == "PINNED"
            for artifact in artifacts
        )
        accepted = (
            candidate.get("license", {}).get("disposition")
            == "ACCEPTED_FOR_BENCHMARK"
        )
        terminal_disposition = candidate.get("admission", {}).get(
            "terminalDisposition"
        )
        plan.append(
            {
                "candidateId": candidate["candidateId"],
                "artifactCount": len(artifacts),
                "hashPinned": pinned,
                "licenseAccepted": accepted,
                "status": (
                    terminal_disposition
                    if isinstance(terminal_disposition, str)
                    else "READY_FOR_LOCAL_PROVISION"
                    if pinned and accepted
                    else "PENDING_EXTERNAL_ARTIFACTS"
                    if not pinned
                    else "PENDING_LICENSE_REVIEW"
                ),
            }
        )
    return {
        "schemaVersion": 2,
        "registryId": registry.get("registryId"),
        "networkUsed": False,
        "candidates": plan,
    }


def _existing_result(output_root: Path) -> dict[str, Any] | None:
    manifest_path = output_root / "asset_manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        result = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    hashes = result.get("fileSha256")
    if not isinstance(hashes, dict):
        return None
    for relative, expected in hashes.items():
        path = output_root / relative
        if (
            Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or not path.is_file()
            or sha256_file(path) != expected
        ):
            return None
    return result


def prepare_candidate(
    candidate: dict[str, Any],
    source_root: Path,
    output_root: Path,
) -> dict[str, Any]:
    candidate_id = candidate.get("candidateId")
    require(
        isinstance(candidate_id, str) and SAFE_ID.fullmatch(candidate_id) is not None,
        "candidate id is unsafe",
    )
    require(
        candidate.get("license", {}).get("disposition")
        == "ACCEPTED_FOR_BENCHMARK",
        f"{candidate_id}: license is not accepted for benchmark use",
    )
    artifacts = candidate.get("artifacts")
    require(isinstance(artifacts, list) and artifacts, "candidate artifacts missing")
    component_ids: set[str] = set()
    for artifact in artifacts:
        require(isinstance(artifact, dict), "artifact must be an object")
        component_id = artifact.get("componentId")
        require(
            isinstance(component_id, str)
            and SAFE_ID.fullmatch(component_id) is not None
            and component_id not in component_ids,
            f"{candidate_id}: component id is unsafe or duplicated",
        )
        component_ids.add(component_id)
        require(
            artifact.get("hashState") == "PINNED"
            and HEX64.fullmatch(str(artifact.get("sha256", ""))) is not None,
            f"{candidate_id}: every artifact must be hash-pinned",
        )
    existing = _existing_result(output_root)
    if existing is not None and existing.get("candidateId") == candidate_id:
        return existing

    output_root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_root.name}.staging-", dir=output_root.parent)
    )
    try:
        files_root = staging / "files"
        files_root.mkdir()
        entries = []
        for artifact in artifacts:
            component_id = artifact["componentId"]
            source = source_root / candidate_id / component_id
            require(source.is_file(), f"{candidate_id}: local component is missing")
            payload = source.read_bytes()
            actual_hash = sha256_bytes(payload)
            require(
                actual_hash == artifact["sha256"],
                f"{candidate_id}/{component_id}: hash mismatch",
            )
            target = files_root / component_id
            target.write_bytes(payload)
            entries.append(
                {
                    "componentId": component_id,
                    "fileRole": artifact["fileRole"],
                    "bytes": len(payload),
                    "sha256": actual_hash,
                }
            )
        entries.sort(key=lambda item: item["componentId"])
        identity = "\n".join(
            f"{entry['componentId']}\0{entry['bytes']}\0{entry['sha256']}"
            for entry in entries
        ).encode()
        file_hashes = {
            f"files/{entry['componentId']}": entry["sha256"] for entry in entries
        }
        result = {
            "schemaVersion": 2,
            "candidateId": candidate_id,
            "licenseDisposition": "ACCEPTED_FOR_BENCHMARK",
            "fileCount": len(entries),
            "extractedBytes": sum(entry["bytes"] for entry in entries),
            "extractedTreeSha256": sha256_bytes(identity),
            "components": entries,
            "fileSha256": file_hashes,
            "sourcePathsPublished": False,
        }
        (staging / "asset_manifest.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        )
        if output_root.exists():
            backup = output_root.parent / f".{output_root.name}.previous-{os.getpid()}"
            require(not backup.exists(), "asset activation backup already exists")
            output_root.replace(backup)
            try:
                staging.replace(output_root)
            except BaseException:
                backup.replace(output_root)
                raise
            shutil.rmtree(backup)
        else:
            staging.replace(output_root)
        return result
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def main() -> int:
    root = Path(__file__).resolve().parent
    repository_root = root.parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, default=root / "candidates.json")
    parser.add_argument("--candidate")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        registry = json.loads(args.registry.read_text())
        if args.candidate is None:
            print(json.dumps(asset_plan(registry), indent=2, sort_keys=True))
            return 0
        require(
            args.source_root is not None,
            "--source-root is required for local provisioning",
        )
        matches = [
            candidate
            for candidate in registry["candidates"]
            if candidate.get("candidateId") == args.candidate
        ]
        require(len(matches) == 1, "candidate must resolve exactly once")
        output = args.output or (
            repository_root
            / "build/desktop_asr_comparison/assets"
            / args.candidate
            / "active"
        )
        result = prepare_candidate(matches[0], args.source_root, output)
    except (OSError, json.JSONDecodeError, KeyError, AssetError) as error:
        print(f"asset preparation: FAIL: {error}")
        return 1
    print(
        "asset preparation: PASS "
        f"candidate={result['candidateId']} files={result['fileCount']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
