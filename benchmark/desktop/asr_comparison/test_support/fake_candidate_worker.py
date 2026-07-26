#!/usr/bin/env python3
"""Deterministic fake JSONL worker for orchestration/reliability tests only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time


def emit(value: dict[str, object]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=[
            "success",
            "child_memory",
            "timeout",
            "malformed",
            "crash",
            "term_resistant",
            "streaming",
        ],
        default="success",
    )
    args = parser.parse_args()
    request = json.loads(sys.stdin.readline())
    if args.mode == "malformed":
        print("{not-json", flush=True)
        return 0
    emit(
        {
            "schemaVersion": 2,
            "type": "handshake",
            "candidateId": request["candidateId"],
            "profileId": request["profileId"],
            "sourceSha256": request["sourceSha256"],
            "processId": os.getpid(),
            "runtimeBindingState": "not_initialized",
        }
    )
    if args.mode == "crash":
        return 17
    if args.mode == "term_resistant":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)",
            ],
            start_new_session=True,
        )
        while True:
            time.sleep(1)
    if args.mode == "timeout":
        time.sleep(300)
        return 0
    child: subprocess.Popen[bytes] | None = None
    if args.mode == "child_memory":
        time.sleep(0.15)
        memory_bytes = int(request.get("memoryBytes", 32 * 1024 * 1024))
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import time; "
                    f"x=bytearray({memory_bytes}); "
                    "x[0]=1; time.sleep(1.0)"
                ),
            ]
        )
        time.sleep(0.2)
    emit(
        {
            "schemaVersion": 2,
            "type": "effectiveConfig",
            "candidateId": request["candidateId"],
            "profileId": request["profileId"],
            "family": "fake_contract_smoke",
            "effectiveConfig": request["effectiveConfig"],
            "capabilities": request["capabilities"],
            "modelFileSha256": {},
        }
    )
    emit(
        {
            "schemaVersion": 2,
            "type": "modelLoadComplete",
            "candidateId": request["candidateId"],
            "loadMilliseconds": 1.0,
            "residentBytes": 1,
        }
    )
    if args.mode == "streaming":
        emit(
            {
                "schemaVersion": 2,
                "type": "partial",
                "candidateId": request["candidateId"],
                "audioSeconds": 0.5,
                "wallMilliseconds": 500.0,
                "textSha256": hashlib.sha256(b"partial").hexdigest(),
            }
        )
    hypothesis = str(request.get("hypothesis", ""))
    emit(
        {
            "schemaVersion": 2,
            "type": "result",
            "candidateId": request["candidateId"],
            "profileId": request["profileId"],
            "sourceSha256": request["sourceSha256"],
            "text": hypothesis,
            "tokens": list(hypothesis),
            "timestamps": [],
            "durationSeconds": float(request["durationSeconds"]),
            "loadMilliseconds": 1.0,
            "decodeMilliseconds": 2.0,
            "partialCount": 1 if args.mode == "streaming" else 0,
            "residentBytes": 1,
        }
    )
    emit(
        {
            "schemaVersion": 2,
            "type": "unloadStart",
            "candidateId": request["candidateId"],
        }
    )
    if child is not None:
        child.wait(timeout=5)
    emit(
        {
            "schemaVersion": 2,
            "type": "unloadComplete",
            "candidateId": request["candidateId"],
            "residentBytes": 1,
        }
    )
    time.sleep(0.1)
    emit(
        {
            "schemaVersion": 2,
            "type": "complete",
            "candidateId": request["candidateId"],
            "profileId": request["profileId"],
            "temporaryArtifactsReleased": True,
            "residentBytesAfterSettle": 1,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
