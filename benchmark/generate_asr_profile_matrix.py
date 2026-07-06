#!/usr/bin/env python3
"""Generate Paraformer ASR benchmark profile matrices."""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path


def profile(
    profile_id: str,
    name: str,
    route: str,
    **kwargs: object,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": profile_id,
        "name": name,
        "route": route,
        "runClass": "warm",
        "loadStrategy": "shared",
        "numThreads": 2,
        "warmupIterations": 1,
    }
    payload.update(kwargs)
    return payload


def standard_whole_profiles() -> list[dict[str, object]]:
    return [
        profile(
            "standard_whole_warm_t2",
            "Standard whole-file warm T2",
            "standard",
            mode="offline",
        )
    ]


def standard_silero_profiles(
    thresholds: list[float],
    min_silences: list[float],
    max_speeches: list[float],
    threads: list[int],
) -> list[dict[str, object]]:
    profiles: list[dict[str, object]] = []
    for threshold, min_silence, max_speech, num_threads in itertools.product(
        thresholds,
        min_silences,
        max_speeches,
        threads,
    ):
        profile_id = (
            f"standard_silero_t{num_threads}_thr{int(threshold * 100):03d}"
            f"_sil{int(min_silence * 1000):04d}_max{int(max_speech * 1000):05d}"
        )
        profiles.append(
            profile(
                profile_id,
                (
                    f"Standard Silero T{num_threads} thr={threshold} "
                    f"sil={min_silence}s max={max_speech}s"
                ),
                "standard",
                mode="vad_segmented_offline",
                numThreads=num_threads,
                vad={
                    "threshold": threshold,
                    "minSilenceDurationSec": min_silence,
                    "minSpeechDurationSec": 0.25,
                    "maxSpeechDurationSec": max_speech,
                },
            )
        )
    return profiles


def realtime_rms_profiles(
    frame_ms_values: list[int],
    speech_thresholds: list[float],
    min_speech_ms_values: list[int],
    end_silence_ms_values: list[int],
    max_segment_ms_values: list[int],
    pre_roll_ms_values: list[int],
    threads: list[int],
) -> list[dict[str, object]]:
    profiles: list[dict[str, object]] = []
    for (
        frame_ms,
        speech_threshold,
        min_speech_ms,
        end_silence_ms,
        max_segment_ms,
        pre_roll_ms,
        num_threads,
    ) in itertools.product(
        frame_ms_values,
        speech_thresholds,
        min_speech_ms_values,
        end_silence_ms_values,
        max_segment_ms_values,
        pre_roll_ms_values,
        threads,
    ):
        profile_id = (
            f"realtime_rms_t{num_threads}_f{frame_ms:03d}_thr{int(speech_threshold):04d}"
            f"_min{min_speech_ms:04d}_end{end_silence_ms:04d}"
            f"_max{max_segment_ms:05d}_pre{pre_roll_ms:04d}"
        )
        profiles.append(
            profile(
                profile_id,
                (
                    f"Realtime RMS T{num_threads} frame={frame_ms} "
                    f"thr={speech_threshold:g} min={min_speech_ms} "
                    f"end={end_silence_ms} max={max_segment_ms} pre={pre_roll_ms}"
                ),
                "realtime_replay",
                vadType="rms",
                numThreads=num_threads,
                frameMs=frame_ms,
                speechThreshold=speech_threshold,
                minSpeechMs=min_speech_ms,
                endSilenceMs=end_silence_ms,
                maxSegmentMs=max_segment_ms,
                preRollMs=pre_roll_ms,
                maxQueuedSegments=2,
            )
        )
    return profiles


def realtime_silero_profiles(
    thresholds: list[float],
    min_silences: list[float],
    max_speeches: list[float],
    frame_ms_values: list[int],
    threads: list[int],
) -> list[dict[str, object]]:
    profiles: list[dict[str, object]] = []
    for threshold, min_silence, max_speech, frame_ms, num_threads in itertools.product(
        thresholds,
        min_silences,
        max_speeches,
        frame_ms_values,
        threads,
    ):
        profile_id = (
            f"realtime_silero_t{num_threads}_f{frame_ms:03d}_thr{int(threshold * 100):03d}"
            f"_sil{int(min_silence * 1000):04d}_max{int(max_speech * 1000):05d}"
        )
        profiles.append(
            profile(
                profile_id,
                (
                    f"Realtime Silero T{num_threads} frame={frame_ms} "
                    f"thr={threshold} sil={min_silence}s max={max_speech}s"
                ),
                "realtime_replay",
                vadType="silero",
                frameMs=frame_ms,
                numThreads=num_threads,
                vad={
                    "threshold": threshold,
                    "minSilenceDurationSec": min_silence,
                    "minSpeechDurationSec": 0.25,
                    "maxSpeechDurationSec": max_speech,
                },
            )
        )
    return profiles


def build_profiles(preset: str) -> list[dict[str, object]]:
    if preset == "coarse":
        return (
            standard_whole_profiles()
            + standard_silero_profiles(
                thresholds=[0.15, 0.20, 0.25, 0.30],
                min_silences=[0.20, 0.25, 0.35, 0.50],
                max_speeches=[5.0, 8.0],
                threads=[2],
            )
            + realtime_rms_profiles(
                frame_ms_values=[200],
                speech_thresholds=[420.0, 520.0, 650.0, 800.0],
                min_speech_ms_values=[320],
                end_silence_ms_values=[500, 720, 1000],
                max_segment_ms_values=[8000, 12000],
                pre_roll_ms_values=[0],
                threads=[2],
            )
            + realtime_silero_profiles(
                thresholds=[0.15, 0.20, 0.25, 0.30],
                min_silences=[0.20, 0.25, 0.35, 0.50],
                max_speeches=[5.0, 8.0],
                frame_ms_values=[100],
                threads=[2],
            )
        )
    if preset == "full":
        return (
            standard_whole_profiles()
            + standard_silero_profiles(
                thresholds=[0.12, 0.15, 0.20, 0.25, 0.30, 0.35],
                min_silences=[0.15, 0.20, 0.25, 0.35, 0.50, 0.70],
                max_speeches=[4.0, 5.0, 8.0, 12.0],
                threads=[1, 2, 4],
            )
            + realtime_rms_profiles(
                frame_ms_values=[80, 120, 200],
                speech_thresholds=[360.0, 420.0, 520.0, 650.0, 800.0],
                min_speech_ms_values=[200, 320, 500],
                end_silence_ms_values=[450, 720, 1000, 1300],
                max_segment_ms_values=[8000, 12000, 16000],
                pre_roll_ms_values=[0, 200],
                threads=[1, 2, 4],
            )
            + realtime_silero_profiles(
                thresholds=[0.12, 0.15, 0.20, 0.25, 0.30, 0.35],
                min_silences=[0.15, 0.20, 0.25, 0.35, 0.50, 0.70],
                max_speeches=[4.0, 5.0, 8.0, 12.0],
                frame_ms_values=[80, 100, 200],
                threads=[1, 2, 4],
            )
        )
    raise ValueError(f"Unsupported preset: {preset}")


def write_batches(output: Path, profiles: list[dict[str, object]], batch_size: int) -> None:
    if batch_size <= 0:
        return
    batch_dir = output.with_suffix("")
    batch_dir.mkdir(parents=True, exist_ok=True)
    for batch_index, start in enumerate(range(0, len(profiles), batch_size), start=1):
        batch_profiles = profiles[start : start + batch_size]
        batch_payload = {
            "version": 1,
            "defaultProfileIds": [item["id"] for item in batch_profiles],
            "profiles": batch_profiles,
        }
        batch_path = batch_dir / f"{output.stem}-batch-{batch_index:03d}.json"
        batch_path.write_text(json.dumps(batch_payload, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preset",
        choices=["coarse", "full"],
        default="coarse",
        help="Matrix size to generate.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("build/asr_benchmark/profile_matrices/paraformer-coarse-grid.json"),
        help="Output profile JSON path.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=0,
        help="Also write per-batch JSON files with this many profiles each.",
    )
    args = parser.parse_args()

    profiles = build_profiles(args.preset)
    ids = [item["id"] for item in profiles]
    duplicates = sorted({profile_id for profile_id in ids if ids.count(profile_id) > 1})
    if duplicates:
        raise SystemExit(f"Duplicate profile id(s): {', '.join(duplicates)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "preset": args.preset,
        "defaultProfileIds": ids,
        "profiles": profiles,
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    write_batches(args.output, profiles, args.batch_size)
    route_counts: dict[str, int] = {}
    for item in profiles:
        route = str(item["route"])
        route_counts[route] = route_counts.get(route, 0) + 1
    print(f"Wrote {args.output}")
    print(f"Profiles: {len(profiles)}")
    for route, count in sorted(route_counts.items()):
        print(f"{route}: {count}")
    if args.batch_size > 0:
        print(f"Batches: {(len(profiles) + args.batch_size - 1) // args.batch_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
