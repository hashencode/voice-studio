#!/usr/bin/env python3
"""Download and safely extract a pinned ASR screening candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = ROOT / "benchmark" / "asr_model_candidates.json"
DEFAULT_OUTPUT_ROOT = ROOT / "build" / "asr_benchmark"
DOWNLOAD_TIMEOUT_SECONDS = 60


def safe_relative_path(value: str, *, label: str, single_component: bool = False) -> Path:
    path = Path(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or (single_component and len(path.parts) != 1)
    ):
        raise ValueError(f"unsafe {label}: {value!r}")
    return path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_candidate(registry: dict[str, Any], candidate_id: str) -> dict[str, Any]:
    matches = [
        candidate
        for candidate in registry.get("candidates", [])
        if candidate.get("id") == candidate_id
    ]
    if len(matches) != 1:
        raise ValueError(f"candidate id must resolve exactly once: {candidate_id}")
    candidate = matches[0]
    if candidate.get("artifact", {}).get("kind") != "download":
        raise ValueError(f"candidate is not a downloadable artifact: {candidate_id}")
    return candidate


def verify(path: Path, expected_sha256: str, expected_bytes: int | None = None) -> None:
    if not path.is_file():
        raise ValueError(f"missing artifact: {path}")
    if expected_bytes is not None and path.stat().st_size != expected_bytes:
        raise ValueError(f"artifact byte-size mismatch: {path}")
    if sha256(path) != expected_sha256:
        raise ValueError(f"artifact sha256 mismatch: {path}")


def download(url: str, destination: Path) -> None:
    try:
        with (
            urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as source,
            destination.open("wb") as output,
        ):
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                output.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def verify_extracted(target: Path, artifact: dict[str, Any]) -> None:
    required_files = artifact["requiredFiles"]
    required_hashes = artifact["requiredFileSha256"]
    for key, relative in required_files.items():
        verify(
            target / safe_relative_path(relative, label=f"required file {key}"),
            required_hashes[key],
        )
    license_text = (
        target
        / safe_relative_path(
            required_files["licenseEvidence"],
            label="license evidence",
        )
    ).read_text(
        encoding="utf-8"
    )
    if "license: apache-2.0" not in license_text.lower():
        raise ValueError("pinned archive no longer contains Apache-2.0 model evidence")


def safe_extract_required(
    archive: Path,
    destination: Path,
    extracted_dir: str,
    required_files: dict[str, str],
) -> None:
    safe_dir = safe_relative_path(
        extracted_dir,
        label="extracted directory",
        single_component=True,
    )
    member_names = {}
    for key, relative_value in required_files.items():
        relative = safe_relative_path(relative_value, label=f"required file {key}")
        member_names[(safe_dir / relative).as_posix()] = relative
    destination.mkdir(parents=True, exist_ok=False)
    found: set[str] = set()
    with tarfile.open(archive, mode="r:bz2") as source:
        for member in source:
            relative = member_names.get(member.name)
            if relative is None:
                continue
            if not member.isfile():
                raise ValueError(f"required archive member is not a file: {member.name}")
            output = (destination / relative).resolve()
            if not output.is_relative_to(destination.resolve()):
                raise ValueError(f"unsafe archive member: {member.name}")
            output.parent.mkdir(parents=True, exist_ok=True)
            extracted = source.extractfile(member)
            if extracted is None:
                raise ValueError(f"cannot read archive member: {member.name}")
            with extracted, output.open("wb") as sink:
                for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                    sink.write(chunk)
            found.add(member.name)
    missing = set(member_names) - found
    if missing:
        raise ValueError(f"archive is missing required members: {sorted(missing)}")


def prepare(
    candidate: dict[str, Any],
    output_root: Path,
) -> Path:
    artifact = candidate["artifact"]
    archive_dir = output_root / "archives"
    models_dir = output_root / "models"
    archive_dir.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)
    archive_name = safe_relative_path(
        artifact["archiveName"],
        label="archive name",
        single_component=True,
    )
    extracted_dir = safe_relative_path(
        artifact["extractedDir"],
        label="extracted directory",
        single_component=True,
    )
    archive = archive_dir / archive_name
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + ".partial")
        partial.unlink(missing_ok=True)
        download(candidate["modelSource"], partial)
        verify(partial, artifact["sha256"], int(artifact["bytes"]))
        partial.replace(archive)
    verify(archive, artifact["sha256"], int(artifact["bytes"]))

    target = models_dir / extracted_dir
    if target.exists():
        verify_extracted(target, artifact)
        return target
    with tempfile.TemporaryDirectory(prefix="asr-candidate-", dir=models_dir) as temp:
        prepared = Path(temp) / extracted_dir
        safe_extract_required(
            archive,
            prepared,
            extracted_dir.as_posix(),
            artifact["requiredFiles"],
        )
        verify_extracted(prepared, artifact)
        prepared.replace(target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate_id")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    args = parser.parse_args()
    try:
        registry = json.loads(args.registry.read_text(encoding="utf-8"))
        target = prepare(find_candidate(registry, args.candidate_id), args.output_root)
    except (KeyError, OSError, tarfile.TarError, TypeError, ValueError) as error:
        print(f"ASR candidate preparation blocked: {error}")
        return 1
    print(f"ASR candidate ready: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
