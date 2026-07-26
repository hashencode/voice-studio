#!/usr/bin/env python3
"""Validate and atomically prepare comparison fixtures without publishing audio."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import random
import shutil
import struct
import tempfile
import wave
from pathlib import Path
from typing import Any


HEX = set("0123456789abcdef")
ROLES = {"smoke", "development", "held_out", "long_7200s"}
DISTRIBUTIONS = {"committed", "generated", "local_only"}
FIXTURE_FIELDS = {
    "fixtureId",
    "fixtureRole",
    "scenario",
    "distributionState",
    "useDisposition",
    "sessionGroupId",
    "speakerGroupId",
    "sourceKind",
    "source",
    "licenseOrConsent",
    "redistribution",
    "referenceReview",
    "varietyReview",
    "freezeState",
    "audio",
    "reference",
    "normalizationNotes",
}
AUDIO_FIELDS = {
    "relativePath",
    "sha256",
    "bytes",
    "durationSeconds",
    "sampleRateHz",
    "channels",
    "sampleWidthBytes",
    "generator",
}
REFERENCE_FIELDS = {"relativePath", "sha256", "bytes"}


class FixtureError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FixtureError(message)


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in HEX for character in value)
    )


def safe_relative(value: Any, location: str) -> Path:
    require(isinstance(value, str) and value, f"{location}: relative path required")
    path = Path(value)
    require(
        not path.is_absolute()
        and ".." not in path.parts
        and not value.startswith("~")
        and "/Users/" not in value
        and "\\Users\\" not in value,
        f"{location}: relative path must not escape or identify a user home",
    )
    return path


def _reject_private_strings(value: Any, location: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            require(
                key
                not in {
                    "absolutePath",
                    "privateMeetingLabel",
                    "speakerName",
                    "speakerIdentity",
                },
                f"{location}: private field {key}",
            )
            _reject_private_strings(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_private_strings(child, f"{location}[{index}]")
    elif isinstance(value, str):
        require(
            not value.startswith("/")
            and not value.startswith("~")
            and "/Users/" not in value
            and "\\Users\\" not in value,
            f"{location}: absolute or user-home value is forbidden",
        )


def validate_manifest(manifest: dict[str, Any], *, ranked: bool) -> None:
    require(
        set(manifest)
        == {
            "schemaVersion",
            "fixtureManifestId",
            "comparisonContractId",
            "pcmFormat",
            "requiredHeldOutScenarios",
            "fixtures",
            "privacyPolicy",
        },
        "fixture manifest fields mismatch",
    )
    require(manifest["schemaVersion"] == 2, "fixture schemaVersion must be 2")
    require(
        manifest["comparisonContractId"]
        == "desktop-processing/macos-asr-comparison-v2",
        "fixture comparison contract mismatch",
    )
    require(
        manifest["pcmFormat"]
        == {
            "sampleRateHz": 16000,
            "channels": 1,
            "sampleWidthBytes": 2,
            "encoding": "signed_pcm_little_endian",
        },
        "fixture PCM format mismatch",
    )
    privacy = manifest["privacyPolicy"]
    require(
        privacy
        == {
            "localOnlyRoot": "build/desktop_asr_comparison/fixtures/local_sources",
            "publishRawAudio": False,
            "publishTranscript": False,
            "publishSpeakerIdentity": False,
            "allowAbsolutePaths": False,
        },
        "fixture privacy policy mismatch",
    )
    fixtures = manifest["fixtures"]
    require(isinstance(fixtures, list) and fixtures, "fixtures must be non-empty")
    ids: set[str] = set()
    development_speakers: set[str] = set()
    development_sessions: set[str] = set()
    held_out_speakers: set[str] = set()
    held_out_sessions: set[str] = set()
    for fixture in fixtures:
        require(isinstance(fixture, dict), "fixture entry must be an object")
        require(set(fixture) == FIXTURE_FIELDS, "fixture fields mismatch")
        fixture_id = fixture["fixtureId"]
        require(
            isinstance(fixture_id, str)
            and fixture_id
            and fixture_id not in ids,
            "fixture ids must be unique",
        )
        ids.add(fixture_id)
        require(fixture["fixtureRole"] in ROLES, f"{fixture_id}: fixture role")
        require(
            fixture["distributionState"] in DISTRIBUTIONS,
            f"{fixture_id}: distribution state",
        )
        require(
            isinstance(fixture["sessionGroupId"], str)
            and isinstance(fixture["speakerGroupId"], str)
            and fixture["sessionGroupId"]
            and fixture["speakerGroupId"],
            f"{fixture_id}: session/speaker group required",
        )
        audio = fixture["audio"]
        reference = fixture["reference"]
        require(
            isinstance(audio, dict) and set(audio) == AUDIO_FIELDS,
            f"{fixture_id}: audio fields mismatch",
        )
        require(
            isinstance(reference, dict) and set(reference) == REFERENCE_FIELDS,
            f"{fixture_id}: reference fields mismatch",
        )
        safe_relative(audio["relativePath"], f"{fixture_id}.audio")
        safe_relative(reference["relativePath"], f"{fixture_id}.reference")
        for payload, label in ((audio, "audio"), (reference, "reference")):
            digest = payload["sha256"]
            size = payload["bytes"]
            require(
                (digest is None and size is None)
                or (is_sha256(digest) and isinstance(size, int) and size >= 0),
                f"{fixture_id}: {label} hash/size state mismatch",
            )
        if fixture["freezeState"] == "FROZEN":
            require(
                is_sha256(audio["sha256"]) and is_sha256(reference["sha256"]),
                f"{fixture_id}: frozen fixture must be hash-pinned",
            )
        else:
            require(
                fixture["freezeState"] == "PENDING_LOCAL_ASSET"
                and fixture["distributionState"] == "local_only",
                f"{fixture_id}: invalid freeze state",
            )
        if fixture["distributionState"] == "generated":
            require(
                audio["generator"]
                in {
                    "silence_v1",
                    "tone_noise_v1",
                    "short_silence_v1",
                    "malformed_v1",
                },
                f"{fixture_id}: unknown generator",
            )
        else:
            require(audio["generator"] is None, f"{fixture_id}: unexpected generator")
        role = fixture["fixtureRole"]
        if role == "development":
            development_speakers.add(fixture["speakerGroupId"])
            development_sessions.add(fixture["sessionGroupId"])
        elif role == "held_out":
            held_out_speakers.add(fixture["speakerGroupId"])
            held_out_sessions.add(fixture["sessionGroupId"])
    require(
        not (development_speakers & held_out_speakers)
        and not (development_sessions & held_out_sessions),
        "development/held-out role leakage detected",
    )
    held_out_scenarios = {
        fixture["scenario"]
        for fixture in fixtures
        if fixture["fixtureRole"] == "held_out"
    }
    require(
        held_out_scenarios == set(manifest["requiredHeldOutScenarios"]),
        "held-out scenario coverage mismatch",
    )
    long_fixtures = [
        fixture for fixture in fixtures if fixture["fixtureRole"] == "long_7200s"
    ]
    require(
        len(long_fixtures) == 1
        and long_fixtures[0]["audio"]["durationSeconds"] == 7200.0
        and long_fixtures[0]["sourceKind"] != "existing_repository_fixture",
        "the finalist fixture must be one real 7,200-second local meeting",
    )
    _reject_private_strings(manifest)
    if ranked:
        dialects = [
            fixture
            for fixture in fixtures
            if fixture["fixtureRole"] == "held_out"
            and fixture["scenario"] == "dialect_accent"
        ]
        require(dialects, "held-out dialect fixture is required")
        frozen_dialects = [
            fixture for fixture in dialects if fixture["freezeState"] == "FROZEN"
        ]
        if frozen_dialects:
            require(
                all(
                    fixture["sourceKind"] == "consented_internal_recording"
                    and fixture["varietyReview"] == "REVIEWED"
                    for fixture in frozen_dialects
                ),
                "held-out dialect variety metadata must be independently reviewed",
            )
        for fixture in fixtures:
            if fixture["fixtureRole"] == "smoke":
                continue
            require(
                fixture["freezeState"] == "FROZEN"
                and fixture["referenceReview"] == "REVIEWED"
                and not fixture["licenseOrConsent"].startswith("PENDING")
                and is_sha256(fixture["audio"]["sha256"])
                and is_sha256(fixture["reference"]["sha256"]),
                f"{fixture['fixtureId']}: ranked fixture is not frozen",
            )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _wav_bytes(samples: list[int]) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return output.getvalue()


def generated_payload(generator: str) -> bytes:
    if generator == "silence_v1":
        return _wav_bytes([0] * 16000)
    if generator == "short_silence_v1":
        return _wav_bytes([0] * 800)
    if generator == "tone_noise_v1":
        source = random.Random(20260726)
        samples = [
            max(
                -32768,
                min(
                    32767,
                    int(
                        1200 * math.sin(2 * math.pi * 440 * index / 16000)
                        + source.randint(-200, 200)
                    ),
                ),
            )
            for index in range(32000)
        ]
        return _wav_bytes(samples)
    if generator == "malformed_v1":
        return b"not-a-wave\x00comparison-v2\n"
    raise FixtureError(f"unknown fixture generator: {generator}")


def _verify_payload(payload: bytes, metadata: dict[str, Any], fixture_id: str) -> None:
    require(len(payload) == metadata["bytes"], f"{fixture_id}: byte size mismatch")
    require(
        sha256_bytes(payload) == metadata["sha256"],
        f"{fixture_id}: hash mismatch",
    )
    if metadata["generator"] == "malformed_v1":
        return
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            require(source.getnchannels() == 1, f"{fixture_id}: channels mismatch")
            require(source.getframerate() == 16000, f"{fixture_id}: sample rate mismatch")
            require(source.getsampwidth() == 2, f"{fixture_id}: sample width mismatch")
            duration = source.getnframes() / source.getframerate()
            require(
                abs(duration - metadata["durationSeconds"]) <= 0.000001,
                f"{fixture_id}: duration mismatch",
            )
    except (wave.Error, EOFError) as error:
        raise FixtureError(f"{fixture_id}: invalid PCM WAV") from error


def _existing_result(output_root: Path) -> dict[str, Any] | None:
    index_path = output_root / "prepared_manifest.json"
    if not index_path.is_file():
        return None
    try:
        result = json.loads(index_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    files = result.get("files")
    hashes = result.get("fileSha256")
    if not isinstance(files, list) or not isinstance(hashes, dict):
        return None
    for relative in files:
        path = output_root / safe_relative(relative, "prepared result")
        if not path.is_file() or sha256_file(path) != hashes.get(relative):
            return None
    return result


def prepare(
    manifest: dict[str, Any],
    *,
    repository_root: Path,
    output_root: Path,
    ranked: bool,
) -> dict[str, Any]:
    validate_manifest(manifest, ranked=ranked)
    if not ranked:
        existing = _existing_result(output_root)
        if existing is not None:
            return existing
    selected = (
        manifest["fixtures"]
        if ranked
        else [
            fixture
            for fixture in manifest["fixtures"]
            if fixture["fixtureRole"] == "smoke"
        ]
    )
    output_parent = output_root.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_root.name}.staging-", dir=output_parent)
    )
    try:
        fixture_root = staging / "fixtures"
        fixture_root.mkdir()
        files: list[str] = []
        hashes: dict[str, str] = {}
        for fixture in selected:
            fixture_id = fixture["fixtureId"]
            audio_metadata = fixture["audio"]
            reference_metadata = fixture["reference"]
            if fixture["distributionState"] == "generated":
                audio_payload = generated_payload(audio_metadata["generator"])
                reference_payload = b""
            else:
                audio_source = repository_root / safe_relative(
                    audio_metadata["relativePath"], f"{fixture_id}.audio"
                )
                reference_source = repository_root / safe_relative(
                    reference_metadata["relativePath"], f"{fixture_id}.reference"
                )
                require(audio_source.is_file(), f"{fixture_id}: audio source missing")
                require(
                    reference_source.is_file(), f"{fixture_id}: reference source missing"
                )
                audio_payload = audio_source.read_bytes()
                reference_payload = reference_source.read_bytes()
            _verify_payload(audio_payload, audio_metadata, fixture_id)
            require(
                len(reference_payload) == reference_metadata["bytes"]
                and sha256_bytes(reference_payload) == reference_metadata["sha256"],
                f"{fixture_id}: reference hash mismatch",
            )
            suffix = Path(audio_metadata["relativePath"]).suffix
            audio_relative = f"fixtures/{fixture_id}{suffix}"
            reference_relative = f"fixtures/{fixture_id}.txt"
            (staging / audio_relative).write_bytes(audio_payload)
            (staging / reference_relative).write_bytes(reference_payload)
            for relative in (audio_relative, reference_relative):
                files.append(relative)
                hashes[relative] = sha256_file(staging / relative)
        result = {
            "schemaVersion": 2,
            "fixtureManifestId": manifest["fixtureManifestId"],
            "mode": "ranked" if ranked else "smoke",
            "fixtureCount": len(selected),
            "files": sorted(files),
            "fileSha256": {key: hashes[key] for key in sorted(hashes)},
        }
        (staging / "prepared_manifest.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        )
        if output_root.exists():
            backup = output_parent / f".{output_root.name}.previous-{os.getpid()}"
            require(not backup.exists(), "fixture activation backup already exists")
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
    parser.add_argument("--manifest", type=Path, default=root / "fixtures.json")
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "build/desktop_asr_comparison/fixtures/active",
    )
    parser.add_argument("--ranked", action="store_true")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        result = prepare(
            manifest,
            repository_root=repository_root,
            output_root=args.output,
            ranked=args.ranked,
        )
    except (OSError, json.JSONDecodeError, FixtureError) as error:
        print(f"fixture preparation: FAIL: {error}")
        return 1
    print(
        "fixture preparation: PASS "
        f"mode={result['mode']} fixtures={result['fixtureCount']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
