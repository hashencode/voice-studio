#!/usr/bin/env python3
"""Build a blind-listening packet for independent timestamp review."""

from __future__ import annotations

import argparse
import hashlib
import json
import wave
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "audio" / "timestamp_manifest.json"
DEFAULT_AUDIO_ROOT = ROOT / "benchmark" / "audio"
DEFAULT_OUTPUT_DIR = ROOT / "build" / "asr_benchmark" / "timestamp_review"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Crop timestamp-review windows and generate a boundary worksheet "
            "that does not expose provisional reference values."
        )
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--audio-root", type=Path, default=DEFAULT_AUDIO_ROOT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_source(case: dict[str, Any], audio_root: Path) -> Path:
    source = (audio_root / str(case["audio"])).resolve()
    resolved_root = audio_root.resolve()
    if not source.is_relative_to(resolved_root) or not source.is_file():
        raise ValueError(f"missing or invalid timestamp fixture: {source}")
    expected_hash = str(case.get("audioSha256", ""))
    if expected_hash and sha256(source) != expected_hash:
        raise ValueError(f"timestamp fixture hash mismatch: {source}")
    return source


def crop_wav(source: Path, destination: Path, start_ms: int, end_ms: int) -> int:
    if start_ms < 0 or end_ms <= start_ms:
        raise ValueError(f"invalid crop window for {source}: {start_ms}..{end_ms}")
    with wave.open(str(source), "rb") as input_wav:
        params = input_wav.getparams()
        if params.comptype != "NONE":
            raise ValueError(f"{source} must be uncompressed PCM WAV")
        start_frame = round(start_ms * params.framerate / 1000)
        end_frame = round(end_ms * params.framerate / 1000)
        if end_frame > params.nframes:
            raise ValueError(f"crop window exceeds fixture duration: {source}")
        input_wav.setpos(start_frame)
        frames = input_wav.readframes(end_frame - start_frame)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(destination), "wb") as output_wav:
        output_wav.setparams(params)
        output_wav.writeframes(frames)
    return round((end_frame - start_frame) * 1000 / params.framerate)


def build_packet(
    manifest: dict[str, Any],
    manifest_path: Path,
    audio_root: Path,
    output_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    packet_cases: list[dict[str, Any]] = []
    worksheet_cases: list[dict[str, Any]] = []
    for case in manifest.get("cases", []):
        if not isinstance(case, dict):
            raise ValueError("manifest cases must be objects")
        case_id = str(case["id"])
        source = validate_source(case, audio_root)
        start_ms = int(case["windowStartMs"])
        end_ms = int(case["windowEndMs"])
        clip_name = f"{case_id}.wav"
        clip_path = output_dir / clip_name
        duration_ms = crop_wav(source, clip_path, start_ms, end_ms)
        clip_hash = sha256(clip_path)
        expected_clip_hash = str(case.get("reviewClipSha256", ""))
        if not expected_clip_hash:
            raise ValueError(f"{case_id} is missing reviewClipSha256")
        if clip_hash != expected_clip_hash:
            raise ValueError(f"timestamp review clip hash mismatch: {clip_path}")
        packet_cases.append(
            {
                "id": case_id,
                "clip": clip_name,
                "clipSha256": clip_hash,
                "durationMs": duration_ms,
                "sourceAudio": str(case["audio"]),
                "sourceAudioSha256": str(case.get("audioSha256", "")),
                "sourceWindowStartMs": start_ms,
                "sourceWindowEndMs": end_ms,
            }
        )
        worksheet_cases.append(
            {
                "id": case_id,
                "clip": clip_name,
                "segments": [],
                "notes": "",
            }
        )

    if not packet_cases:
        raise ValueError("manifest contains no timestamp cases")
    packet = {
        "schemaVersion": 1,
        "timebase": "cropped_audio_milliseconds",
        "sourceManifest": str(manifest_path.resolve()),
        "cases": packet_cases,
    }
    worksheet = {
        "schemaVersion": 1,
        "timebase": "cropped_audio_milliseconds",
        "reviewStatus": "pending",
        "reviewer": "",
        "reviewedAt": "",
        "independentListeningReview": True,
        "cases": worksheet_cases,
    }
    return packet, worksheet


def main() -> int:
    args = parse_args()
    try:
        manifest = load_json(args.manifest)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        packet, worksheet = build_packet(
            manifest,
            args.manifest,
            args.audio_root,
            args.output_dir,
        )
        (args.output_dir / "review_packet.json").write_text(
            json.dumps(packet, ensure_ascii=False, indent=2) + "\n"
        )
        (args.output_dir / "annotations.template.json").write_text(
            json.dumps(worksheet, ensure_ascii=False, indent=2) + "\n"
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Timestamp review packet blocked: {error}")
        return 1
    print(f"Timestamp review packet: {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
