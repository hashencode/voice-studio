#!/usr/bin/env python3
"""Build a local-only, hash-bound SenseVoice live-caption fixture pack."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import random
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
CHANNELS = 1
DATASET = "google/fleurs"
DATASET_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
DATASET_LICENSE = "CC-BY-4.0"
SILENCE = b"\0" * round(0.25 * SAMPLE_RATE * SAMPLE_WIDTH)


class FixturePreparationError(RuntimeError):
    pass


@dataclass(frozen=True)
class SourceRow:
    language: str
    split: str
    row_index: int
    source_id: int
    samples: int
    text: str
    audio_url: str

    @property
    def duration_seconds(self) -> float:
        return self.samples / SAMPLE_RATE


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FixturePreparationError(message)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_rows(language: str, split: str, *, offset: int = 0) -> list[SourceRow]:
    query = urllib.parse.urlencode(
        {
            "dataset": DATASET,
            "config": language,
            "split": split,
            "offset": offset,
            "length": 100,
        }
    )
    request = urllib.request.Request(
        f"https://datasets-server.huggingface.co/rows?{query}",
        headers={"User-Agent": "voice2text-development-benchmark/1"},
    )
    document = json.loads(_read_request(request).decode())
    rows: list[SourceRow] = []
    for item in document.get("rows", []):
        row = item.get("row", {})
        audio = row.get("audio")
        if (
            not isinstance(audio, list)
            or not audio
            or not isinstance(audio[0], dict)
        ):
            continue
        url = str(audio[0].get("src", ""))
        require(
            f"/{DATASET_REVISION}/--/{language}/{split}/" in url,
            "FLEURS dataset revision drifted",
        )
        text = str(row.get("raw_transcription", "")).strip()
        samples = int(row.get("num_samples", 0))
        if text and samples > 0:
            rows.append(
                SourceRow(
                    language=language,
                    split=split,
                    row_index=int(item["row_idx"]),
                    source_id=int(row["id"]),
                    samples=samples,
                    text=text,
                    audio_url=url,
                )
            )
    require(len(rows) >= 40, f"{language}/{split} returned too few rows")
    return rows


def download_pcm(row: SourceRow, source_root: Path) -> bytes:
    target = source_root / f"{row.language}-{row.split}-{row.row_index}.wav"
    if not target.is_file():
        request = urllib.request.Request(
            row.audio_url,
            headers={"User-Agent": "voice2text-development-benchmark/1"},
        )
        payload = _read_request(request)
        temporary = target.with_suffix(".wav.tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(payload)
        os.replace(temporary, target)
    conversion = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(target),
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "s16le",
            "pipe:1",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    require(
        conversion.returncode == 0 and bool(conversion.stdout),
        "ffmpeg could not normalize a FLEURS row",
    )
    pcm = conversion.stdout
    require(
        len(pcm) == row.samples * SAMPLE_WIDTH,
        "source sample count drifted",
    )
    return pcm


def _read_request(request: urllib.request.Request) -> bytes:
    error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.URLError as current:
            error = current
            if attempt < 3:
                time.sleep(1 << attempt)
    raise FixturePreparationError(
        f"download failed after retries for {request.full_url}: {error}"
    )


def take_duration(
    rows: Iterable[SourceRow],
    seconds: float,
    *,
    excluded: set[tuple[str, str, int]] | None = None,
) -> list[SourceRow]:
    selected: list[SourceRow] = []
    duration = 0.0
    excluded = excluded or set()
    for row in rows:
        identity = (row.language, row.split, row.row_index)
        if identity in excluded:
            continue
        selected.append(row)
        duration += row.duration_seconds
        if duration >= seconds:
            break
    require(duration >= seconds, "row set cannot satisfy fixture duration")
    return selected


def concat_pcm(
    rows: list[SourceRow],
    source_root: Path,
    transform: Callable[[bytes, int], bytes] | None = None,
) -> bytes:
    parts: list[bytes] = []
    for index, row in enumerate(rows):
        pcm = download_pcm(row, source_root)
        parts.append(transform(pcm, index) if transform else pcm)
        parts.append(SILENCE)
    return b"".join(parts)


def far_field(pcm: bytes, index: int) -> bytes:
    samples = array.array("h")
    samples.frombytes(pcm)
    delay = 960 + index * 37
    random_source = random.Random(20260728 + index)
    result = array.array("h")
    for position, sample in enumerate(samples):
        echo = samples[position - delay] if position >= delay else 0
        noise = random_source.randint(-180, 180)
        value = round(sample * 0.58 + echo * 0.24 + noise)
        result.append(max(-32768, min(32767, value)))
    return result.tobytes()


def keyboard_overlay(pcm: bytes, index: int) -> bytes:
    samples = array.array("h")
    samples.frombytes(pcm)
    interval = SAMPLE_RATE // 3
    for start in range((index + 1) * 701, len(samples), interval):
        for offset in range(min(96, len(samples) - start)):
            pulse = round(2200 * math.exp(-offset / 18) * (1 if offset % 2 else -1))
            samples[start + offset] = max(
                -32768,
                min(32767, samples[start + offset] + pulse),
            )
    return samples.tobytes()


def mix_pcm(first: bytes, second: bytes) -> bytes:
    left = array.array("h")
    right = array.array("h")
    left.frombytes(first)
    right.frombytes(second)
    length = max(len(left), len(right))
    result = array.array("h")
    for index in range(length):
        a = left[index] if index < len(left) else 0
        b = right[index] if index < len(right) else 0
        result.append(max(-32768, min(32767, round(a * 0.72 + b * 0.68))))
    return result.tobytes()


def write_fixture(
    *,
    output_root: Path,
    fixture_id: str,
    role: str,
    scenario: str,
    pcm: bytes,
    reference: str,
    rows: list[SourceRow],
    transformation: str,
) -> dict[str, Any]:
    audio = output_root / f"{fixture_id}.wav"
    text = output_root / f"{fixture_id}.txt"
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output_root, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with wave.open(str(temporary_path), "wb") as destination:
            destination.setnchannels(CHANNELS)
            destination.setsampwidth(SAMPLE_WIDTH)
            destination.setframerate(SAMPLE_RATE)
            destination.writeframes(pcm)
        os.replace(temporary_path, audio)
    finally:
        temporary_path.unlink(missing_ok=True)
    text_payload = (reference.strip() + "\n").encode()
    text.write_bytes(text_payload)
    identities = [
        {
            "language": row.language,
            "split": row.split,
            "rowIndex": row.row_index,
            "sourceId": row.source_id,
        }
        for row in rows
    ]
    return {
        "fixtureId": fixture_id,
        "fixtureRole": role,
        "scenario": scenario,
        "freezeState": "FROZEN",
        "distributionState": "local_only",
        "audio": {
            "relativePath": audio.name,
            "sha256": sha256_file(audio),
            "bytes": audio.stat().st_size,
            "durationSeconds": len(pcm) / (SAMPLE_RATE * SAMPLE_WIDTH),
        },
        "reference": {
            "relativePath": text.name,
            "sha256": sha256_bytes(text_payload),
            "bytes": len(text_payload),
        },
        "sourceRows": identities,
        "sourceRowIdentitySha256": sha256_bytes(
            json.dumps(identities, sort_keys=True, separators=(",", ":")).encode()
        ),
        "transformation": transformation,
    }


def _text(rows: Iterable[SourceRow]) -> str:
    return " ".join(row.text for row in rows)


def build_role(
    *,
    role: str,
    split: str,
    zh_rows: list[SourceRow],
    en_rows: list[SourceRow],
    output_root: Path,
    source_root: Path,
) -> list[dict[str, Any]]:
    clean_zh = take_duration(zh_rows, 32)
    clean_en = take_duration(en_rows, 32)
    terminology_candidates = sorted(
        zh_rows,
        key=lambda row: (
            sum(character.isdigit() for character in row.text),
            sum(token in row.text for token in ("年", "月", "日", "公里", "大学", "技术")),
            len(row.text),
        ),
        reverse=True,
    )
    terminology = take_duration(terminology_candidates, 32)
    code_rows: list[SourceRow] = []
    for zh, en in zip(zh_rows[10:16], en_rows[10:16]):
        code_rows.extend((zh, en))
    short_rows = sorted(
        [*zh_rows, *en_rows],
        key=lambda row: row.duration_seconds,
    )[:4]
    long_rows = sorted(
        [*zh_rows, *en_rows],
        key=lambda row: row.duration_seconds,
        reverse=True,
    )[:3]
    fixtures = [
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-clean-mandarin",
            role=role,
            scenario="clean_near_field_mandarin",
            pcm=concat_pcm(clean_zh, source_root),
            reference=_text(clean_zh),
            rows=clean_zh,
            transformation="concat_with_250ms_silence_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-clean-english",
            role=role,
            scenario="clean_near_field_english",
            pcm=concat_pcm(clean_en, source_root),
            reference=_text(clean_en),
            rows=clean_en,
            transformation="concat_with_250ms_silence_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-far-field",
            role=role,
            scenario="far_field_noisy_meeting",
            pcm=concat_pcm(clean_zh, source_root, far_field),
            reference=_text(clean_zh),
            rows=clean_zh,
            transformation="deterministic_echo_attenuation_noise_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-code-switch",
            role=role,
            scenario="zh_en_code_switch",
            pcm=concat_pcm(code_rows, source_root),
            reference=_text(code_rows),
            rows=code_rows,
            transformation="alternating_zh_en_utterances_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-terminology-numbers",
            role=role,
            scenario="terminology_numbers",
            pcm=concat_pcm(terminology, source_root),
            reference=_text(terminology),
            rows=terminology,
            transformation="priority_selected_fleurs_rows_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-keyboard-noise",
            role=role,
            scenario="keyboard_noise",
            pcm=concat_pcm(clean_en, source_root, keyboard_overlay),
            reference=_text(clean_en),
            rows=clean_en,
            transformation="deterministic_keyboard_impulse_overlay_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-long-utterance",
            role=role,
            scenario="long_utterance",
            pcm=concat_pcm(long_rows, source_root),
            reference=_text(long_rows),
            rows=long_rows,
            transformation="longest_source_rows_v1",
        ),
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-short-confirmation",
            role=role,
            scenario="short_confirmation",
            pcm=concat_pcm(short_rows, source_root),
            reference=_text(short_rows),
            rows=short_rows,
            transformation="shortest_source_rows_v1",
        ),
    ]
    dual_rows = [*zh_rows[20:24], *en_rows[20:24]]
    dual_parts: list[bytes] = []
    for zh, en in zip(zh_rows[20:24], en_rows[20:24]):
        dual_parts.append(
            mix_pcm(
                download_pcm(zh, source_root),
                download_pcm(en, source_root),
            )
        )
        dual_parts.append(SILENCE)
    fixtures.append(
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-double-talk",
            role=role,
            scenario="system_microphone_double_talk",
            pcm=b"".join(dual_parts),
            reference=_text(dual_rows),
            rows=dual_rows,
            transformation="paired_zh_en_dual_track_mix_v1",
        )
    )
    non_speech_seconds = 30
    non_speech = keyboard_overlay(
        b"\0" * (non_speech_seconds * SAMPLE_RATE * SAMPLE_WIDTH),
        7,
    )
    fixtures.append(
        write_fixture(
            output_root=output_root,
            fixture_id=f"{role}-non-speech",
            role=role,
            scenario="non_speech",
            pcm=non_speech,
            reference="",
            rows=[],
            transformation="deterministic_keyboard_impulses_without_speech_v1",
        )
    )
    require(
        all(row.split == split for fixture in fixtures for row in (
            SourceRow(
                language=item["language"],
                split=item["split"],
                row_index=item["rowIndex"],
                source_id=item["sourceId"],
                samples=1,
                text="x",
                audio_url="x",
            )
            for item in fixture["sourceRows"]
        )),
        "fixture role leaked rows from another split",
    )
    return fixtures


def build(output_root: Path) -> dict[str, Any]:
    sources = output_root / "sources"
    development = build_role(
        role="development",
        split="validation",
        zh_rows=fetch_rows("cmn_hans_cn", "validation"),
        en_rows=fetch_rows("en_us", "validation"),
        output_root=output_root,
        source_root=sources,
    )
    held_out = build_role(
        role="held_out",
        split="validation",
        zh_rows=fetch_rows("cmn_hans_cn", "validation", offset=100),
        en_rows=fetch_rows("en_us", "validation", offset=100),
        output_root=output_root,
        source_root=sources,
    )
    replay_sources = [
        fixture
        for fixture in held_out
        if fixture["scenario"]
        in {
            "clean_near_field_mandarin",
            "clean_near_field_english",
            "far_field_noisy_meeting",
            "zh_en_code_switch",
            "terminology_numbers",
            "keyboard_noise",
            "system_microphone_double_talk",
        }
    ]
    pcm_parts: list[bytes] = []
    references: list[str] = []
    replay_rows: list[SourceRow] = []
    while len(b"".join(pcm_parts)) / (SAMPLE_RATE * SAMPLE_WIDTH) < 900:
        for fixture in replay_sources:
            audio_path = output_root / fixture["audio"]["relativePath"]
            with wave.open(str(audio_path), "rb") as source:
                pcm_parts.append(source.readframes(source.getnframes()))
            references.append(
                (output_root / fixture["reference"]["relativePath"])
                .read_text(encoding="utf-8")
                .strip()
            )
    replay_pcm = b"".join(pcm_parts)[: 900 * SAMPLE_RATE * SAMPLE_WIDTH]
    stability = write_fixture(
        output_root=output_root,
        fixture_id="stability-multiscene-15m",
        role="stability",
        scenario="bounded_multiscene_replay",
        pcm=replay_pcm,
        reference=" ".join(references),
        rows=replay_rows,
        transformation="repeat_held_out_multiscene_to_exactly_900s_v1",
    )
    manifest = {
        "schemaVersion": 1,
        "fixtureManifestId": "sensevoice-live-caption-fleurs-v1",
        "status": "FROZEN",
        "dataset": {
            "id": DATASET,
            "revision": DATASET_REVISION,
            "license": DATASET_LICENSE,
            "datasetCard": "https://huggingface.co/datasets/google/fleurs",
            "localOnly": True,
            "redistribution": "never_commit_audio",
            "roleAllocation": {
                "development": "validation rows 0-99",
                "heldOut": "validation rows 100-199, never used for arm selection",
            },
        },
        "pcmFormat": {
            "sampleRateHz": SAMPLE_RATE,
            "channels": CHANNELS,
            "sampleWidthBytes": SAMPLE_WIDTH,
        },
        "requiredScenarios": [
            "clean_near_field_mandarin",
            "clean_near_field_english",
            "far_field_noisy_meeting",
            "zh_en_code_switch",
            "terminology_numbers",
            "keyboard_noise",
            "system_microphone_double_talk",
            "long_utterance",
            "short_confirmation",
            "non_speech",
        ],
        "fixtures": [*development, *held_out, stability],
        "limitations": [
            "FLEURS is read speech, not a captured meeting corpus.",
            "Far-field, keyboard-noise, code-switch and double-talk scenarios are deterministic transformations.",
            "The stability replay is repeated input and is excluded from quality ranking.",
        ],
    }
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = build(args.output_root.resolve())
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.manifest.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, args.manifest)
    except (OSError, ValueError, urllib.error.URLError, FixturePreparationError) as error:
        print(f"SenseVoice live fixtures: FAIL: {error}")
        return 1
    print(
        json.dumps(
            {
                "status": manifest["status"],
                "fixtureCount": len(manifest["fixtures"]),
                "manifestSha256": sha256_file(args.manifest),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
