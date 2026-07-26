#!/usr/bin/env python3
"""Run the pinned FunASR comparison on the fixed desktop ASR corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import threading
import time
import wave
from pathlib import Path
from typing import Any

import psutil


FIXTURE_SHA256 = "9345f80fc835ae2afc9bb58ccdbd5047797d7de3afc4cb3a2c6ef44444a2a562"
REFERENCE_SHA256 = "40046fed2ac99717645087d59dfc54d764ec84e6554ec0879e699bbc4cdb231a"
MODEL_REVISIONS = {
    "asr": (
        "iic/speech_paraformer-large-vad-punc_"
        "asr_nat-zh-cn-16k-common-vocab8404-pytorch@v2.0.5"
    ),
    "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch@v2.0.4",
    "punctuation": (
        "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch@v2.0.3"
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--asr-model", type=Path, required=True)
    parser.add_argument("--vad-model", type=Path, required=True)
    parser.add_argument("--punc-model", type=Path, required=True)
    parser.add_argument("--environment-lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def sha256_file(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_identity(root: Path) -> dict[str, Any]:
    entries: list[tuple[str, int, str]] = []
    for source in sorted(path for path in root.rglob("*") if path.is_file()):
        entries.append(
            (str(source.relative_to(root)), source.stat().st_size, sha256_file(source))
        )
    encoded = "\n".join(
        f"{relative}\0{size}\0{digest}" for relative, size, digest in entries
    ).encode()
    return {
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "bytes": sum(entry[1] for entry in entries),
        "fileCount": len(entries),
    }


def normalize(text: str) -> str:
    return "".join(character for character in text.lower() if character.isalnum())


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_value in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_value != right_value),
                )
            )
        previous = current
    return previous[-1]


def system_value(name: str) -> str:
    return subprocess.check_output(
        ["/usr/sbin/sysctl", "-n", name], text=True
    ).strip()


def main() -> int:
    args = parse_args()
    roots = (args.asr_model, args.vad_model, args.punc_model)
    for source in (
        args.audio,
        args.reference,
        args.environment_lock,
        *roots,
    ):
        source.resolve(strict=True)
    if sha256_file(args.audio) != FIXTURE_SHA256:
        raise ValueError("desktop ASR fixture identity changed")
    if sha256_file(args.reference) != REFERENCE_SHA256:
        raise ValueError("desktop ASR reference identity changed")
    with wave.open(str(args.audio), "rb") as stream:
        duration_seconds = stream.getnframes() / stream.getframerate()

    process = psutil.Process()
    rss_before = process.memory_info().rss
    peak_rss = rss_before
    sampling = True

    def sample() -> None:
        nonlocal peak_rss
        while sampling:
            peak_rss = max(peak_rss, process.memory_info().rss)
            time.sleep(0.05)

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    cold_started = time.monotonic()
    from funasr import AutoModel

    load_started = time.monotonic()
    model = AutoModel(
        model=str(args.asr_model),
        vad_model=str(args.vad_model),
        punc_model=str(args.punc_model),
        device="cpu",
        disable_update=True,
        hub="ms",
    )
    load_seconds = time.monotonic() - load_started
    inference_started = time.monotonic()
    result = model.generate(
        input=str(args.audio),
        batch_size_s=60,
        batch_size_threshold_s=60,
        use_itn=True,
    )
    inference_seconds = time.monotonic() - inference_started
    total_seconds = time.monotonic() - cold_started
    sampling = False
    sampler.join(timeout=1)
    peak_rss = max(peak_rss, process.memory_info().rss)

    if not result or not isinstance(result[0], dict):
        raise ValueError("FunASR returned no structured result")
    item = result[0]
    hypothesis = str(item.get("text", "")).strip()
    reference = normalize(args.reference.read_text())
    normalized_hypothesis = normalize(hypothesis)
    if not reference or not normalized_hypothesis:
        raise ValueError("FunASR comparison text is empty")
    raw_timestamps = item.get("timestamp")
    raw_sentences = item.get("sentence_info")
    timestamp_count = len(raw_timestamps) if isinstance(raw_timestamps, list) else 0
    sentence_count = len(raw_sentences) if isinstance(raw_sentences, list) else 0
    punctuation_present = any(mark in hypothesis for mark in "，。！？；,.!?;")
    identity = {
        role: {
            "id": MODEL_REVISIONS[role],
            **directory_identity(root),
            "licenseSpdx": "Apache-2.0",
        }
        for role, root in zip(MODEL_REVISIONS, roots, strict=True)
    }
    evidence = {
        "schemaVersion": 1,
        "unit": "U6",
        "candidate": "funasr-paraformer",
        "targetFingerprint": {
            "operatingSystem": "macos",
            "operatingSystemVersion": platform.mac_ver()[0],
            "architecture": platform.machine(),
            "cpuModel": system_value("machdep.cpu.brand_string"),
            "logicalCpuCount": psutil.cpu_count(),
            "memoryBytes": int(system_value("hw.memsize")),
            "runtimeId": "funasr-paraformer-macos-arm64",
            "runtimeVersion": "funasr-1.3.22-python-3.12.13",
            "runtimeSha256": sha256_file(args.environment_lock),
        },
        "environment": {
            "python": platform.python_version(),
            "funasr": "1.3.22",
            "modelscope": "1.38.1",
            "torch": "2.11.0",
            "environmentLockSha256": sha256_file(args.environment_lock),
            "processingNetwork": "framework_offline_flags",
            "device": "cpu",
        },
        "models": identity,
        "fixture": {
            "id": "fixed-zh-meeting-300s",
            "sha256": FIXTURE_SHA256,
            "referenceSha256": REFERENCE_SHA256,
            "durationSeconds": duration_seconds,
        },
        "components": {
            "paraformer": True,
            "vad": True,
            "punctuation": punctuation_present,
            "itnRequested": True,
            "timestamps": timestamp_count > 0 or sentence_count > 0,
            "timestampCount": timestamp_count,
            "sentenceCount": sentence_count,
        },
        "metrics": {
            "coldStartupSeconds": load_seconds,
            "inferenceSeconds": inference_seconds,
            "elapsedSeconds": total_seconds,
            "rtf": total_seconds / duration_seconds,
            "inferenceRtf": inference_seconds / duration_seconds,
            "cer": edit_distance(reference, normalized_hypothesis) / len(reference),
            "residentBytesBefore": rss_before,
            "peakResidentBytes": peak_rss,
            "incrementalPeakRssBytes": max(0, peak_rss - rss_before),
        },
        "hypothesis": hypothesis,
        "rawShape": {
            "keys": sorted(item),
            "timestampCount": timestamp_count,
            "sentenceCount": sentence_count,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps(evidence["metrics"], sort_keys=True))
    return 0


if __name__ == "__main__":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("MODELSCOPE_OFFLINE", "1")
    raise SystemExit(main())
