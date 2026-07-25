#!/usr/bin/env python3
"""Generate the deterministic S2 speech-enhancement comparison set."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import random
import sys
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "audio" / "s2_noise_manifest.json"
DEFAULT_OUTPUT = ROOT / "build" / "asr_benchmark" / "s2_noise"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate deterministic quiet/noise/near/far GTCRN fixtures.",
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1:
        raise ValueError("unsupported S2 noise manifest schema")
    if not value.get("cases"):
        raise ValueError("S2 noise manifest contains no cases")
    return value


def read_pcm16(path: Path) -> tuple[wave._wave_params, array.array[int]]:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        if (
            params.nchannels != 1
            or params.sampwidth != 2
            or params.framerate != 16_000
            or params.comptype != "NONE"
        ):
            raise ValueError("source must be mono 16-bit 16 kHz PCM WAV")
        samples = array.array("h")
        samples.frombytes(source.readframes(params.nframes))
    if sys.byteorder != "little":
        samples.byteswap()
    return params, samples


def is_inside_burst(
    index: int,
    sample_rate: int,
    windows_ms: list[list[int]],
) -> bool:
    position_ms = (index * 1000) // sample_rate
    return any(start <= position_ms < end for start, end in windows_ms)


def render_case(
    source: array.array[int],
    sample_rate: int,
    case: dict[str, Any],
    seed: int,
) -> array.array[int]:
    gain = float(case["sourceGain"])
    snr = case.get("noiseSnrDb")
    burst_windows = case.get("burstWindowsMs", [])
    source_rms = math.sqrt(sum(float(value) ** 2 for value in source) / len(source))
    noise_peak = 0.0
    if snr is not None:
        signal_rms = source_rms * gain
        noise_rms = signal_rms / math.sqrt(10 ** (float(snr) / 10.0))
        noise_peak = noise_rms * math.sqrt(3.0)
    randomizer = random.Random(seed)
    output = array.array("h")
    for index, value in enumerate(source):
        add_noise = snr is not None and (
            not burst_windows
            or is_inside_burst(index, sample_rate, burst_windows)
        )
        noise = randomizer.uniform(-noise_peak, noise_peak) if add_noise else 0.0
        mixed = round((value * gain) + noise)
        output.append(max(-32768, min(32767, mixed)))
    return output


def write_pcm16(
    path: Path,
    params: wave._wave_params,
    samples: array.array[int],
) -> None:
    payload = array.array("h", samples)
    if sys.byteorder != "little":
        payload.byteswap()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setparams(params)
        output.writeframes(payload.tobytes())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    manifest = load_manifest(args.manifest)
    source_path = ROOT / manifest["source"]["audio"]
    expected_hash = manifest["source"]["audioSha256"]
    if sha256(source_path) != expected_hash:
        raise ValueError("source audio SHA-256 does not match the manifest")
    params, source = read_pcm16(source_path)
    seed = int(manifest["generation"]["seed"])
    generated: list[dict[str, Any]] = []
    for index, case in enumerate(manifest["cases"]):
        samples = render_case(source, params.framerate, case, seed + index)
        output_path = args.output / f"{case['id']}.wav"
        write_pcm16(output_path, params, samples)
        generated.append(
            {
                "id": case["id"],
                "path": str(output_path.resolve()),
                "sha256": sha256(output_path),
                "frames": len(samples),
            },
        )
    report = {
        "schemaVersion": 1,
        "sourceSha256": expected_hash,
        "seed": seed,
        "cases": generated,
    }
    report_path = args.output / "generated_manifest.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(generated)} cases and {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
