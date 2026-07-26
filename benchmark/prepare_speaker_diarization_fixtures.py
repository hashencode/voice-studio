#!/usr/bin/env python3
"""Generate deterministic licensed fixtures for the S3 speaker gate."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "speaker_diarization_admission_contract.json"
DEFAULT_SOURCES = ROOT / "build" / "speaker_diarization" / "sources"
DEFAULT_OUTPUT = ROOT / "build" / "speaker_diarization" / "fixtures"
SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class SourceClip:
    id: str
    speaker: str
    samples: array.array[int]
    sha256: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_pcm16_mono(path: Path) -> array.array[int]:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != SAMPLE_RATE
            or source.getcomptype() != "NONE"
        ):
            raise ValueError(f"{path} must be mono 16-bit 16 kHz PCM WAV")
        samples = array.array("h")
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ValueError(f"{path} contains no PCM samples")
    return samples


def write_pcm16(path: Path, samples: array.array[int]) -> None:
    payload = array.array("h", samples)
    if sys.byteorder != "little":
        payload.byteswap()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(payload.tobytes())


def load_clips(
    manifest: dict[str, Any],
    source_root: Path,
) -> list[SourceClip]:
    configured = manifest.get("fixtureSources")
    if not isinstance(configured, list) or len(configured) < 2:
        raise ValueError("fixtureSources must contain at least two source clips")
    clips: list[SourceClip] = []
    speakers: set[str] = set()
    for item in configured:
        path = source_root / str(item["file"])
        actual_hash = sha256(path)
        if actual_hash != item.get("sha256"):
            raise ValueError(f"{path} SHA-256 does not match the manifest")
        speaker = str(item["speaker"])
        speakers.add(speaker)
        clips.append(
            SourceClip(
                id=str(item["id"]),
                speaker=speaker,
                samples=read_pcm16_mono(path),
                sha256=actual_hash,
            )
        )
    if len(speakers) < 2:
        raise ValueError("fixtureSources must represent at least two speakers")
    return clips


def _mix_into(
    destination: array.array[int],
    source: array.array[int],
    start: int,
) -> int:
    end = min(len(destination), start + len(source))
    for index in range(start, end):
        mixed = destination[index] + source[index - start]
        destination[index] = max(-32768, min(32767, mixed))
    return end


def render_functional_fixture(
    clips: list[SourceClip],
    duration_seconds: int,
) -> tuple[array.array[int], list[dict[str, Any]], list[list[float]], list[list[float]]]:
    total_frames = duration_seconds * SAMPLE_RATE
    output = array.array("h", [0]) * total_frames
    turns: list[dict[str, Any]] = []
    overlaps: list[list[float]] = []
    silence_regions: list[list[float]] = []
    cursor = min(total_frames, int(0.35 * SAMPLE_RATE))
    if cursor:
        silence_regions.append([0.0, cursor / SAMPLE_RATE])
    turn_index = 0
    while cursor < total_frames:
        clip = clips[turn_index % len(clips)]
        start = cursor
        end = _mix_into(output, clip.samples, start)
        if end <= start:
            break
        turns.append(
            {
                "speaker": clip.speaker,
                "start": start / SAMPLE_RATE,
                "end": end / SAMPLE_RATE,
            }
        )
        turn_end = end
        if turn_index % 4 == 2:
            secondary = next(
                candidate
                for candidate in clips
                if candidate.speaker != clip.speaker
            )
            overlap_start = start + max(1, (end - start) * 11 // 20)
            secondary_end = _mix_into(output, secondary.samples, overlap_start)
            if secondary_end > overlap_start:
                turns.append(
                    {
                        "speaker": secondary.speaker,
                        "start": overlap_start / SAMPLE_RATE,
                        "end": secondary_end / SAMPLE_RATE,
                    }
                )
                overlap_end = min(end, secondary_end)
                if overlap_end > overlap_start:
                    overlaps.append(
                        [overlap_start / SAMPLE_RATE, overlap_end / SAMPLE_RATE]
                    )
                turn_end = max(turn_end, secondary_end)
        gap_frames = int((0.25 + (turn_index % 3) * 0.1) * SAMPLE_RATE)
        gap_end = min(total_frames, turn_end + gap_frames)
        if gap_end > turn_end:
            silence_regions.append(
                [turn_end / SAMPLE_RATE, gap_end / SAMPLE_RATE]
            )
        cursor = gap_end
        turn_index += 1
    turns.sort(key=lambda turn: (turn["start"], turn["end"], turn["speaker"]))
    return output, turns, overlaps, silence_regions


def write_rttm(path: Path, turns: list[dict[str, Any]]) -> None:
    lines = []
    for turn in turns:
        duration = turn["end"] - turn["start"]
        if duration <= 0:
            continue
        lines.append(
            "SPEAKER speaker-functional-5m 1 "
            f"{turn['start']:.6f} {duration:.6f} "
            f"<NA> <NA> {turn['speaker']} <NA> <NA>"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_resource_fixture(
    path: Path,
    clips: list[SourceClip],
    duration_seconds: int,
) -> int:
    total_frames = duration_seconds * SAMPLE_RATE
    path.parent.mkdir(parents=True, exist_ok=True)
    silence = array.array("h", [0]) * int(0.25 * SAMPLE_RATE)
    if sys.byteorder != "little":
        silence.byteswap()
    written = 0
    clip_index = 0
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        while written < total_frames:
            clip = array.array("h", clips[clip_index % len(clips)].samples)
            remaining = total_frames - written
            if len(clip) > remaining:
                del clip[remaining:]
            if sys.byteorder != "little":
                clip.byteswap()
            output.writeframesraw(clip.tobytes())
            written += len(clip)
            if written >= total_frames:
                break
            silence_frames = min(len(silence), total_frames - written)
            output.writeframesraw(silence[:silence_frames].tobytes())
            written += silence_frames
            clip_index += 1
    return written


def _artifact(path: Path, frames: int) -> dict[str, Any]:
    return {
        "path": path.name,
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "frames": frames,
        "durationSeconds": frames / SAMPLE_RATE,
    }


def prepare_fixtures(
    *,
    manifest: dict[str, Any],
    source_root: Path,
    output_root: Path,
    functional_duration_seconds: int = 300,
    resource_duration_seconds: int = 7_200,
) -> dict[str, Any]:
    if manifest.get("schemaVersion") != 2:
        raise ValueError("unsupported speaker diarization contract schema")
    clips = load_clips(manifest, source_root)
    output_root.mkdir(parents=True, exist_ok=True)
    functional_path = output_root / "speaker-functional-5m.wav"
    rttm_path = output_root / "speaker-functional-5m.rttm"
    resource_path = output_root / "speaker-resource-120m.wav"
    functional, turns, overlaps, silence_regions = render_functional_fixture(
        clips,
        functional_duration_seconds,
    )
    write_pcm16(functional_path, functional)
    write_rttm(rttm_path, turns)
    resource_frames = render_resource_fixture(
        resource_path,
        clips,
        resource_duration_seconds,
    )
    report = {
        "schemaVersion": 2,
        "contractId": manifest.get("contractId"),
        "sampleRate": SAMPLE_RATE,
        "sourceHashes": {clip.id: clip.sha256 for clip in clips},
        "functional": {
            **_artifact(functional_path, len(functional)),
            "rttmPath": rttm_path.name,
            "rttmSha256": sha256(rttm_path),
            "turnCount": len(turns),
            "overlapRegions": overlaps,
            "silenceRegions": silence_regions,
        },
        "resource": _artifact(resource_path, resource_frames),
        "semanticContract": {
            "activityWithoutAttribution": "UNKNOWN",
            "noActivity": "SILENCE",
        },
    }
    report_path = output_root / "generated_manifest.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    report = prepare_fixtures(
        manifest=manifest,
        source_root=args.source_root,
        output_root=args.output,
    )
    print(
        "Prepared speaker diarization fixtures: "
        f"functional={report['functional']['sha256']} "
        f"resource={report['resource']['sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
