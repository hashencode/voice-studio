#!/usr/bin/env python3
"""Prepare local-only M4 streaming and non-repeated operational fixtures."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import wave
from pathlib import Path
from typing import Any

from prepare_m4_fleurs_fixtures import (
    CHANNELS,
    LICENSE,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    _load_rows,
    _write_fixture,
    sha256_bytes,
    sha256_file,
)


class ObservationFixtureError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ObservationFixtureError(message)


def _read_manifest(root: Path, language_lane: str) -> dict[str, Any]:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    require(manifest.get("languageLane") == language_lane, "language lane mismatch")
    return manifest


def _select_streaming_row(rows: list[Any], offset: int) -> Any:
    streaming_rows = [
        row for row in rows if 8.0 <= row.duration_seconds <= 20.0
    ]
    require(
        0 <= offset < len(streaming_rows),
        "streaming row offset is outside the bounded row set",
    )
    return streaming_rows[offset]


def _operational_fixture(
    *,
    language_lane: str,
    validation_root: Path,
    held_out_root: Path,
    output_root: Path,
) -> tuple[dict[str, Any], list[str]]:
    validation = _read_manifest(validation_root, language_lane)
    held_out = _read_manifest(held_out_root, language_lane)
    selected = [
        (validation_root, fixture)
        for fixture in validation["fixtures"]
        if fixture["fixtureRole"] == "development"
    ] + [
        (held_out_root, fixture)
        for fixture in held_out["fixtures"]
        if fixture["fixtureRole"] == "held_out"
    ]
    require(len(selected) == 10, "operational fixture requires ten distinct scenarios")
    output_root.mkdir(parents=True, exist_ok=True)
    audio_path = output_root / f"m4-{language_lane}-operational-multiscene.wav"
    reference_path = output_root / f"m4-{language_lane}-operational-multiscene.txt"
    silence = b"\0" * (SAMPLE_RATE * SAMPLE_WIDTH_BYTES)
    pcm_parts: list[bytes] = []
    references: list[str] = []
    source_hashes: list[str] = []
    scenarios: list[str] = []
    for root, fixture in selected:
        source = root / fixture["audioRelativePath"]
        reference = root / fixture["referenceRelativePath"]
        require(sha256_file(source) == fixture["audioSha256"], "audio hash mismatch")
        require(
            sha256_file(reference) == fixture["referenceSha256"],
            "reference hash mismatch",
        )
        with wave.open(str(source), "rb") as source_wave:
            require(
                source_wave.getframerate() == SAMPLE_RATE
                and source_wave.getnchannels() == CHANNELS
                and source_wave.getsampwidth() == SAMPLE_WIDTH_BYTES,
                "PCM format mismatch",
            )
            pcm_parts.append(source_wave.readframes(source_wave.getnframes()))
        pcm_parts.append(silence)
        references.append(reference.read_text(encoding="utf-8").strip())
        source_hashes.append(fixture["audioSha256"])
        scenarios.append(fixture["scenario"])
    pcm = b"".join(pcm_parts)
    with tempfile.NamedTemporaryFile(dir=output_root, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with wave.open(str(temporary_path), "wb") as destination:
            destination.setnchannels(CHANNELS)
            destination.setsampwidth(SAMPLE_WIDTH_BYTES)
            destination.setframerate(SAMPLE_RATE)
            destination.writeframes(pcm)
        os.replace(temporary_path, audio_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    reference_path.write_text(" ".join(references).strip() + "\n", encoding="utf-8")
    fixture = {
        "fixtureId": f"m4-{language_lane}-operational-multiscene",
        "languageLane": language_lane,
        "fixtureRole": "operational",
        "scenario": "ten_distinct_multiscene_blocks",
        "distributionState": "local_only",
        "durationSeconds": len(pcm) / (SAMPLE_RATE * SAMPLE_WIDTH_BYTES),
        "audioRelativePath": audio_path.name,
        "audioSha256": sha256_file(audio_path),
        "referenceRelativePath": reference_path.name,
        "referenceSha256": sha256_file(reference_path),
        "sourceFixtureCount": len(selected),
        "sourceFixtureIdentitySha256": sha256_bytes(
            "\n".join(source_hashes).encode()
        ),
        "transformation": "concat_ten_distinct_scenario_fixtures_with_1s_silence_v1",
    }
    return fixture, scenarios


def prepare(
    *,
    language_lane: str,
    parquet_path: Path,
    source_split: str,
    validation_root: Path,
    held_out_root: Path,
    output_root: Path,
    streaming_row_offset: int = 0,
) -> dict[str, Any]:
    rows = _load_rows(parquet_path)
    streaming_row = _select_streaming_row(rows, streaming_row_offset)
    streaming = _write_fixture(
        output_root=output_root,
        fixture_id=f"m4-{language_lane}-streaming-utterance",
        language_lane=language_lane,
        role="streaming",
        scenario="clean_read_speech_streaming_latency",
        rows=[streaming_row],
        far_field=False,
    )
    operational, scenarios = _operational_fixture(
        language_lane=language_lane,
        validation_root=validation_root,
        held_out_root=held_out_root,
        output_root=output_root,
    )
    manifest = {
        "schemaVersion": 1,
        "kind": "m4_asr_local_observation_fixture_manifest",
        "languageLane": language_lane,
        "source": {
            "dataset": "google/fleurs",
            "license": LICENSE,
            "streamingSplit": source_split,
            "parquetSha256": sha256_file(parquet_path),
            "validationManifestSha256": sha256_file(
                validation_root / "manifest.json"
            ),
            "heldOutManifestSha256": sha256_file(held_out_root / "manifest.json"),
            "rawAudioPublished": False,
            "referenceTextPublished": False,
        },
        "operationalScenarioBlocks": scenarios,
        "fixtures": [streaming, operational],
    }
    output_root.mkdir(parents=True, exist_ok=True)
    temporary = output_root / "manifest.json.tmp"
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, output_root / "manifest.json")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--language-lane", choices=("zh", "en"), required=True)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--source-split", required=True)
    parser.add_argument("--validation-root", type=Path, required=True)
    parser.add_argument("--held-out-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--streaming-row-offset", type=int, default=0)
    args = parser.parse_args()
    try:
        manifest = prepare(
            language_lane=args.language_lane,
            parquet_path=args.parquet,
            source_split=args.source_split,
            validation_root=args.validation_root,
            held_out_root=args.held_out_root,
            output_root=args.output_root,
            streaming_row_offset=args.streaming_row_offset,
        )
    except (OSError, json.JSONDecodeError, ObservationFixtureError) as error:
        print(f"M4 observation fixtures: FAIL: {error}")
        return 1
    print(
        json.dumps(
            {
                "languageLane": manifest["languageLane"],
                "fixtureCount": len(manifest["fixtures"]),
                "operationalSeconds": manifest["fixtures"][1]["durationSeconds"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
