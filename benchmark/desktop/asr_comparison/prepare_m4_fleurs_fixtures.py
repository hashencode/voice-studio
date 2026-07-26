#!/usr/bin/env python3
"""Prepare local-only, hash-bound M4 Mandarin/English FLEURS fixtures."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import os
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


SAMPLE_RATE = 16_000
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1
STABILITY_SECONDS = 300.0
DEVELOPMENT_SCENARIO_SECONDS = 360.0
SILENCE_SECONDS = 0.2
LICENSE = "CC-BY-4.0"
DATASET_CARD = "https://huggingface.co/datasets/google/fleurs"


class FixturePreparationError(RuntimeError):
    pass


@dataclass(frozen=True)
class SourceRow:
    row_id: int
    num_samples: int
    audio_bytes: bytes
    transcription: str
    gender: int

    @property
    def duration_seconds(self) -> float:
        return self.num_samples / SAMPLE_RATE


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_duration(
    rows: Iterable[SourceRow], target_seconds: float
) -> tuple[list[SourceRow], list[SourceRow]]:
    if target_seconds <= 0:
        raise ValueError("target duration must be positive")
    selected: list[SourceRow] = []
    remaining: list[SourceRow] = []
    duration = 0.0
    for row in rows:
        if duration < target_seconds:
            selected.append(row)
            duration += row.duration_seconds
        else:
            remaining.append(row)
    if duration < target_seconds:
        raise FixturePreparationError(
            f"source rows provide only {duration:.3f}s, need {target_seconds:.3f}s"
        )
    return selected, remaining


def terminology_priority(row: SourceRow, language_lane: str) -> tuple[int, int, int]:
    text = row.transcription
    digit_count = sum(character.isdigit() for character in text)
    if language_lane == "en":
        marked_terms = sum(
            token[:1].isupper() for token in text.split() if len(token) > 1
        )
    else:
        marked_terms = sum(
            marker in text
            for marker in ("年", "月", "日", "百分之", "公里", "公司", "大学", "技术")
        )
    return (digit_count, marked_terms, len(text))


def far_field_noise_pcm(
    pcm: bytes, *, seed: int, delay_samples: int = 1280
) -> bytes:
    samples = array.array("h")
    samples.frombytes(pcm)
    if os.sys.byteorder != "little":
        samples.byteswap()
    state = seed & 0x7FFFFFFF
    transformed = array.array("h")
    for index, sample in enumerate(samples):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        noise = ((state >> 16) & 0x7FFF) % 401 - 200
        delayed = samples[index - delay_samples] if index >= delay_samples else 0
        value = round(sample * 0.62 + delayed * 0.2 + noise)
        transformed.append(max(-32768, min(32767, value)))
    if os.sys.byteorder != "little":
        transformed.byteswap()
    return transformed.tobytes()


def _decode_pcm(audio_bytes: bytes) -> bytes:
    process = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "s16le",
            "pipe:1",
        ],
        input=audio_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0 or not process.stdout:
        raise FixturePreparationError("ffmpeg failed to decode a FLEURS row")
    return process.stdout


def _write_fixture(
    *,
    output_root: Path,
    fixture_id: str,
    language_lane: str,
    role: str,
    scenario: str,
    rows: list[SourceRow],
    far_field: bool,
) -> dict[str, Any]:
    audio_path = output_root / f"{fixture_id}.wav"
    reference_path = output_root / f"{fixture_id}.txt"
    silence = b"\0" * round(SILENCE_SECONDS * SAMPLE_RATE * SAMPLE_WIDTH_BYTES)
    pcm_parts: list[bytes] = []
    references: list[str] = []
    for index, row in enumerate(rows):
        pcm = _decode_pcm(row.audio_bytes)
        if far_field:
            pcm = far_field_noise_pcm(
                pcm,
                seed=(row.row_id << 8) ^ index ^ 0x20260727,
            )
        pcm_parts.append(pcm)
        pcm_parts.append(silence)
        references.append(row.transcription.strip())
    pcm = b"".join(pcm_parts)
    reference = " ".join(value for value in references if value).strip() + "\n"
    output_root.mkdir(parents=True, exist_ok=True)
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
    temporary_reference = reference_path.with_suffix(".txt.tmp")
    temporary_reference.write_text(reference, encoding="utf-8")
    os.replace(temporary_reference, reference_path)
    duration_seconds = len(pcm) / (
        SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES
    )
    row_identity = "\n".join(str(row.row_id) for row in rows).encode()
    return {
        "fixtureId": fixture_id,
        "languageLane": language_lane,
        "fixtureRole": role,
        "scenario": scenario,
        "distributionState": "local_only",
        "durationSeconds": duration_seconds,
        "audioRelativePath": audio_path.name,
        "audioSha256": sha256_file(audio_path),
        "referenceRelativePath": reference_path.name,
        "referenceSha256": sha256_file(reference_path),
        "sourceRowCount": len(rows),
        "sourceRowIdentitySha256": sha256_bytes(row_identity),
        "transformation": (
            "deterministic_echo_attenuation_and_bounded_noise_v1"
            if far_field
            else "concat_with_200ms_silence_v1"
        ),
    }


def _load_rows(parquet_path: Path) -> list[SourceRow]:
    try:
        import pyarrow.parquet as parquet
    except ModuleNotFoundError as error:
        raise FixturePreparationError("pyarrow is required") from error
    table = parquet.read_table(
        parquet_path,
        columns=["id", "num_samples", "audio", "transcription", "gender"],
    )
    rows: list[SourceRow] = []
    for value in table.to_pylist():
        audio = value["audio"]
        transcription = str(value["transcription"]).strip()
        if not transcription or not isinstance(audio, dict) or not audio.get("bytes"):
            continue
        rows.append(
            SourceRow(
                row_id=int(value["id"]),
                num_samples=int(value["num_samples"]),
                audio_bytes=bytes(audio["bytes"]),
                transcription=transcription,
                gender=int(value["gender"]),
            )
        )
    rows.sort(key=lambda row: row.row_id)
    if not rows:
        raise FixturePreparationError("FLEURS parquet contains no usable rows")
    return rows


def prepare_language(
    *,
    parquet_path: Path,
    output_root: Path,
    language_lane: str,
    source_split: str,
    role_set: str = "development",
) -> dict[str, Any]:
    if role_set not in {"development", "held_out"}:
        raise ValueError("role_set must be development or held_out")
    rows = _load_rows(parquet_path)
    if role_set == "development":
        stability, remaining = select_duration(rows, STABILITY_SECONDS)
    else:
        stability = []
        remaining = rows
    terminology_order = sorted(
        remaining,
        key=lambda row: terminology_priority(row, language_lane),
        reverse=True,
    )
    terminology, _ = select_duration(
        terminology_order, DEVELOPMENT_SCENARIO_SECONDS
    )
    terminology_ids = {row.row_id for row in terminology}
    remaining = [row for row in remaining if row.row_id not in terminology_ids]
    allocations: dict[str, list[SourceRow]] = {}
    for scenario in (
        "clean",
        "far_field_noise",
        "accent_speaker_variability_proxy",
        "long_form",
    ):
        allocations[scenario], remaining = select_duration(
            remaining, DEVELOPMENT_SCENARIO_SECONDS
        )
    allocations["terminology_numbers"] = terminology
    fixtures = []
    if stability:
        fixtures.append(
            _write_fixture(
                output_root=output_root,
                fixture_id=f"m4-{language_lane}-stability-5m",
                language_lane=language_lane,
                role="stability",
                scenario="clean_read_speech",
                rows=stability,
                far_field=False,
            )
        )
    for scenario, scenario_rows in allocations.items():
        fixtures.append(
            _write_fixture(
                output_root=output_root,
                fixture_id=f"m4-{language_lane}-{role_set}-{scenario}",
                language_lane=language_lane,
                role=role_set,
                scenario=scenario,
                rows=scenario_rows,
                far_field=scenario == "far_field_noise",
            )
        )
    return {
        "schemaVersion": 1,
        "kind": "m4_fleurs_local_fixture_manifest",
        "languageLane": language_lane,
        "source": {
            "dataset": "google/fleurs",
            "datasetCard": DATASET_CARD,
            "license": LICENSE,
            "split": source_split,
            "parquetSha256": sha256_file(parquet_path),
            "rawAudioPublished": False,
            "referenceTextPublished": False,
        },
        "pcmFormat": {
            "sampleRateHz": SAMPLE_RATE,
            "channels": CHANNELS,
            "sampleWidthBytes": SAMPLE_WIDTH_BYTES,
        },
        "fixtures": fixtures,
        "developmentTotalSeconds": sum(
            fixture["durationSeconds"]
            for fixture in fixtures
            if fixture["fixtureRole"] == "development"
        ),
        "heldOutTotalSeconds": sum(
            fixture["durationSeconds"]
            for fixture in fixtures
            if fixture["fixtureRole"] == "held_out"
        ),
        "limitations": [
            "FLEURS is read speech rather than real meeting speech.",
            "The Mandarin split has no independently reviewed accent labels; the accent scenario is a speaker-variability proxy only.",
            "Far-field and noise are deterministic transformations, not captured room acoustics.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--language-lane", choices=("zh", "en"), required=True)
    parser.add_argument("--source-split", default="validation")
    parser.add_argument(
        "--role-set",
        choices=("development", "held_out"),
        default="development",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_root = args.output_root.resolve()
    manifest = prepare_language(
        parquet_path=args.parquet.resolve(),
        output_root=output_root,
        language_lane=args.language_lane,
        source_split=args.source_split,
        role_set=args.role_set,
    )
    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "languageLane": args.language_lane,
                "fixtureCount": len(manifest["fixtures"]),
                "developmentTotalSeconds": manifest["developmentTotalSeconds"],
                "heldOutTotalSeconds": manifest["heldOutTotalSeconds"],
                "manifestSha256": sha256_file(manifest_path),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
