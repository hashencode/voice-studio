#!/usr/bin/env python3
"""Small protocol worker used only by sidecar contract tests."""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path


ROOT = Path(os.environ["SIDECAR_JOB_ROOT"])
MODE = (ROOT / "fixture-mode").read_text().strip()


def emit(
    kind: str,
    message_id: str,
    payload: dict,
    job_id: str | None = None,
    attempt_id: str | None = None,
) -> None:
    print(
        json.dumps(
            {
                "protocolVersion": 1,
                "type": kind,
                "messageId": message_id,
                "jobId": job_id,
                "attemptId": attempt_id,
                "payload": payload,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


def sandbox_is_closed() -> bool:
    secret_names = {
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "HF_TOKEN",
        "PAIRING_SECRET",
    }
    if secret_names & set(os.environ):
        return False
    file_denied = False
    network_denied = False
    repository_probe = Path(__file__).resolve().parents[3] / "pubspec.yaml"
    try:
        repository_probe.read_bytes()
    except OSError:
        file_denied = True
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=0.1)
    except PermissionError:
        network_denied = True
    except OSError:
        # A connection refusal does not demonstrate sandbox denial.
        network_denied = False
    return file_denied and network_denied


def main() -> int:
    runtime_version = "wrong" if MODE == "version-mismatch" else "fixture-1"
    emit(
        "handshake",
        "handshake-1",
        {
            "runtimeId": "fixture",
            "runtimeVersion": runtime_version,
            "capabilities": ["asr.zh"],
        },
    )
    emit(
        "capability",
        "capability-1",
        {
            "capabilities": ["asr.zh"],
            "maxSegments": 10,
            "networkDuringProcessing": False,
            "pathRoots": ["job", "runtime", "model"],
        },
    )
    for line in sys.stdin:
        message = json.loads(line)
        if message["type"] == "shutdown":
            return 0
        if message["type"] != "job":
            continue
        if MODE == "crash":
            return 17
        if MODE == "hang":
            while True:
                time.sleep(1)
        if MODE == "memory":
            allocation = bytearray(128 * 1024 * 1024)
            allocation[0] = 1
            while True:
                time.sleep(1)
        if MODE == "oversize":
            print("x" * (1024 * 1024 + 1), flush=True)
            continue
        if MODE == "sandbox" and not sandbox_is_closed():
            emit(
                "error",
                "error-1",
                {"code": "SANDBOX_OPEN", "retryable": False},
                message["jobId"],
                message["attemptId"],
            )
            continue
        attempt_id = (
            "stale-attempt"
            if MODE == "stale"
            else message["attemptId"]
        )
        emit(
            "progress",
            "progress-1",
            {"phase": "fixture", "fraction": 0.5},
            message["jobId"],
            attempt_id,
        )
        emit(
            "result",
            "result-1",
            {
                "engineId": "fixture",
                "segments": [
                    {
                        "startSeconds": 0,
                        "endSeconds": 1,
                        "text": "fixture",
                        "speakerAssignment": "unknown",
                        "anonymousSpeakerKey": None,
                    }
                ],
            },
            message["jobId"],
            attempt_id,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
