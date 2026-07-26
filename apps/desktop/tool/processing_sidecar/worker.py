#!/usr/bin/env python3
"""Versioned JSONL worker shared by FunASR and pyannote candidates."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 1024 * 1024
MAX_SEGMENTS = 200_000
ENGINE = os.environ.get("SIDECAR_ENGINE", "")
JOB_ROOT = Path(os.environ.get("SIDECAR_JOB_ROOT", "")).resolve()
MODEL_ROOT = Path(os.environ.get("SIDECAR_MODEL_ROOT", "")).resolve()


def emit(
    message_type: str,
    message_id: str,
    payload: dict[str, Any],
    *,
    job_id: str | None = None,
    attempt_id: str | None = None,
) -> None:
    encoded = json.dumps(
        {
            "protocolVersion": PROTOCOL_VERSION,
            "type": message_type,
            "messageId": message_id,
            "jobId": job_id,
            "attemptId": attempt_id,
            "payload": payload,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if len(encoded.encode()) > MAX_LINE_BYTES:
        raise ValueError("sidecar output exceeds JSONL limit")
    print(encoded, flush=True)


def capabilities() -> tuple[str, str, list[str]]:
    if ENGINE == "funasr":
        return (
            "funasr-paraformer-macos-arm64",
            "funasr-1.3.22-python-3.12.13",
            ["asr.zh", "vad", "punctuation", "itn", "timestamps"],
        )
    if ENGINE == "pyannote":
        return (
            "pyannote-community-1-macos-arm64",
            "pyannote-audio-4.0.4-python-3.12.13",
            ["diarization", "overlap", "anonymous-speakers"],
        )
    raise ValueError("unsupported sidecar engine")


def contained_source(payload: dict[str, Any]) -> Path:
    source = payload.get("source")
    if not isinstance(source, dict) or source.get("root") != "job":
        raise ValueError("source must use the job root")
    relative = source.get("relativePath")
    if not isinstance(relative, str) or not relative:
        raise ValueError("source relative path is missing")
    candidate = (JOB_ROOT / relative).resolve(strict=True)
    if candidate != JOB_ROOT and JOB_ROOT not in candidate.parents:
        raise ValueError("source path escapes the job root")
    if not candidate.is_file() or candidate.is_symlink():
        raise ValueError("source must be an immutable regular file")
    expected_bytes = source.get("bytes")
    expected_hash = source.get("sha256")
    if candidate.stat().st_size != expected_bytes:
        raise ValueError("source byte count changed")
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError("source SHA-256 changed")
    return candidate


def funasr_job(source: Path, payload: dict[str, Any]) -> dict[str, Any]:
    import psutil
    from funasr import AutoModel

    started = time.monotonic()
    asr_model = (MODEL_ROOT / "asr").resolve(strict=True)
    vad_model = (MODEL_ROOT / "vad").resolve(strict=True)
    punctuation_model = (MODEL_ROOT / "punctuation").resolve(strict=True)
    model = AutoModel(
        model=str(asr_model),
        vad_model=str(vad_model),
        punc_model=str(punctuation_model),
        device="cpu",
        disable_update=True,
        hub="ms",
    )
    result = model.generate(
        input=str(source),
        batch_size_s=60,
        batch_size_threshold_s=60,
        use_itn=True,
    )
    if not result or not isinstance(result[0], dict):
        raise ValueError("FunASR returned no result")
    item = result[0]
    text = str(item.get("text", "")).strip()
    raw_sentences = item.get("sentence_info")
    raw_timestamps = item.get("timestamp")
    duration = float(payload["durationSeconds"])
    segments: list[dict[str, Any]] = []
    if isinstance(raw_sentences, list) and raw_sentences:
        for sentence in raw_sentences:
            if not isinstance(sentence, dict):
                continue
            sentence_text = str(sentence.get("text", "")).strip()
            start_ms = sentence.get("start")
            end_ms = sentence.get("end")
            if sentence_text and isinstance(start_ms, (int, float)) and isinstance(
                end_ms, (int, float)
            ):
                segments.append(
                    {
                        "startSeconds": max(0.0, float(start_ms) / 1000),
                        "endSeconds": min(duration, float(end_ms) / 1000),
                        "text": sentence_text,
                        "speakerAssignment": "unknown",
                        "anonymousSpeakerKey": None,
                    }
                )
    if not segments and isinstance(raw_timestamps, list) and raw_timestamps and text:
        starts = [
            float(pair[0]) / 1000
            for pair in raw_timestamps
            if isinstance(pair, list) and len(pair) == 2
        ]
        ends = [
            float(pair[1]) / 1000
            for pair in raw_timestamps
            if isinstance(pair, list) and len(pair) == 2
        ]
        if starts and ends:
            segments.append(
                {
                    "startSeconds": max(0.0, min(starts)),
                    "endSeconds": min(duration, max(ends)),
                    "text": text,
                    "speakerAssignment": "unknown",
                    "anonymousSpeakerKey": None,
                }
            )
    if not segments:
        raise ValueError("FunASR result lacks bounded timestamps")
    if len(segments) > min(int(payload["maxSegments"]), MAX_SEGMENTS):
        raise ValueError("FunASR segment output exceeds limit")
    return {
        "engineId": "funasr-1.3.22/paraformer-v2.0.5",
        "segments": segments,
        "metrics": {
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
            "residentBytesAfter": psutil.Process().memory_info().rss,
        },
        "components": {
            "asr": True,
            "vad": True,
            "punctuation": any(mark in text for mark in "，。！？；"),
            "itnRequested": True,
            "timestamps": True,
        },
    }


def pyannote_job(source: Path, payload: dict[str, Any]) -> dict[str, Any]:
    import psutil
    import soundfile
    import torch
    from pyannote.audio import Pipeline

    started = time.monotonic()
    samples, sample_rate = soundfile.read(str(source), dtype="float32")
    waveform = torch.from_numpy(samples)
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.transpose(0, 1)
    pipeline = Pipeline.from_pretrained(str(MODEL_ROOT))
    output = pipeline({"waveform": waveform, "sample_rate": sample_rate})
    diarization = output.speaker_diarization
    labels: dict[str, str] = {}
    turns: list[dict[str, Any]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        anonymous = labels.setdefault(speaker, f"speaker_{len(labels) + 1:02d}")
        turns.append(
            {
                "startSeconds": float(turn.start),
                "endSeconds": float(turn.end),
                "speakerAssignment": "anonymous",
                "anonymousSpeakerKey": anonymous,
            }
        )
    if not turns or len(turns) > min(int(payload["maxSegments"]), MAX_SEGMENTS):
        raise ValueError("pyannote output is empty or exceeds limit")
    return {
        "engineId": "pyannote-audio-4.0.4/community-1",
        "speakerTurns": turns,
        "metrics": {
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
            "residentBytesAfter": psutil.Process().memory_info().rss,
        },
    }


def process_job(envelope: dict[str, Any]) -> None:
    job_id = envelope.get("jobId")
    attempt_id = envelope.get("attemptId")
    payload = envelope.get("payload")
    if not isinstance(job_id, str) or not isinstance(attempt_id, str):
        raise ValueError("job identifiers are required")
    if not isinstance(payload, dict):
        raise ValueError("job payload is required")
    source = contained_source(payload)
    emit(
        "progress",
        "progress-start",
        {"phase": "loading", "fraction": 0.0},
        job_id=job_id,
        attempt_id=attempt_id,
    )
    result = (
        funasr_job(source, payload)
        if ENGINE == "funasr"
        else pyannote_job(source, payload)
    )
    emit(
        "result",
        "result-final",
        result,
        job_id=job_id,
        attempt_id=attempt_id,
    )


def main() -> int:
    runtime_id, runtime_version, advertised = capabilities()
    emit(
        "handshake",
        "handshake-1",
        {
            "runtimeId": runtime_id,
            "runtimeVersion": runtime_version,
            "capabilities": advertised,
        },
    )
    emit(
        "capability",
        "capability-1",
        {
            "capabilities": advertised,
            "maxSegments": MAX_SEGMENTS,
            "networkDuringProcessing": False,
            "pathRoots": ["job", "runtime", "model"],
        },
    )
    for line in sys.stdin.buffer:
        if len(line) > MAX_LINE_BYTES:
            raise ValueError("input exceeds JSONL limit")
        envelope = json.loads(line)
        if envelope.get("protocolVersion") != PROTOCOL_VERSION:
            raise ValueError("protocol version mismatch")
        message_type = envelope.get("type")
        if message_type == "job":
            try:
                process_job(envelope)
            except Exception as error:
                emit(
                    "error",
                    "error-final",
                    {
                        "code": "SIDECAR_JOB_FAILED",
                        "retryable": True,
                        "message": type(error).__name__,
                    },
                    job_id=envelope.get("jobId"),
                    attempt_id=envelope.get("attemptId"),
                )
        elif message_type in {"cancel", "shutdown"}:
            return 0
        else:
            raise ValueError("unsupported input message")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
