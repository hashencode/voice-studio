#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path


CHECKPOINT = "desktop-benchmark: native diarizer initialized"


def wait_for_checkpoint(process: subprocess.Popen[str], timeout_seconds: float) -> list[str]:
    if process.stdout is None:
        raise RuntimeError("worker output pipe is unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    lines: list[str] = []
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            remainder = process.stdout.read()
            if remainder:
                lines.extend(remainder.splitlines())
            raise RuntimeError(
                f"worker exited before native checkpoint: {process.returncode}"
            )
        events = selector.select(timeout=min(0.25, deadline - time.monotonic()))
        for key, _ in events:
            line = key.fileobj.readline()
            if not line:
                continue
            lines.append(line.rstrip())
            if CHECKPOINT in line:
                return lines
    raise TimeoutError("worker did not reach the native diarizer checkpoint")


def process_group_exists(process_group_id: int) -> bool:
    listing = subprocess.run(
        ["ps", "-axo", "pgid="],
        check=True,
        capture_output=True,
        text=True,
    )
    return process_group_id in {
        int(value) for value in listing.stdout.split() if value.isdigit()
    }


def run(args: argparse.Namespace) -> dict[str, object]:
    root = args.root.resolve()
    evidence_root = args.evidence_root.resolve()
    evidence_root.mkdir(parents=True, exist_ok=True)
    build_root = root / "build" / "desktop_benchmark"
    build_root.mkdir(parents=True, exist_ok=True)
    worker_root = Path(tempfile.mkdtemp(prefix="cancel-worker-", dir=build_root))
    reference = json.loads(args.reference_evidence.read_text())
    command = [str(root / "benchmark/desktop/run_macos_sherpa_baseline.sh"), "functional"]
    environment = dict(os.environ)
    environment["OUTPUT_ROOT"] = str(worker_root)
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=root,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
        bufsize=1,
    )
    checkpoint_lines: list[str] = []
    exit_code: int | None = None
    group_gone = False
    published_files: list[str] = []
    released = False
    try:
        checkpoint_lines = wait_for_checkpoint(process, args.startup_timeout_seconds)
        time.sleep(args.cancel_after_checkpoint_seconds)
        if process.poll() is not None:
            raise RuntimeError("worker completed before cancellation could be exercised")
        os.killpg(process.pid, signal.SIGTERM)
        try:
            exit_code = process.wait(timeout=args.termination_timeout_seconds)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            exit_code = process.wait(timeout=5)
            raise RuntimeError("worker ignored SIGTERM and required SIGKILL")
        time.sleep(0.1)
        group_gone = not process_group_exists(process.pid)
        published_files = sorted(
            path.name for path in worker_root.iterdir() if path.is_file()
        )
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        shutil.rmtree(worker_root)
        released = not worker_root.exists()

    if exit_code == 0:
        raise RuntimeError("worker cancellation returned a successful exit code")
    if published_files:
        raise RuntimeError(f"worker published partial files: {published_files}")
    if not group_gone:
        raise RuntimeError("worker process group still exists after cancellation")
    if not released:
        raise RuntimeError("worker temporary directory was not released")

    return {
        "schemaVersion": 1,
        "contractId": reference["contractId"],
        "source": "macos_native_sherpa_worker",
        "complete": False,
        "timedOut": True,
        "cancelled": True,
        "temporaryArtifactsReleased": released,
        "targetFingerprint": reference["targetFingerprint"],
        "nativeProgressCallbackCancellationSupported": False,
        "nativeCallbackReturnValueDisposition": "ignored_by_sherpa_1_13_4",
        "workerTermination": {
            "boundary": "separate_process_group",
            "nativeCheckpoint": "native_diarizer_initialized",
            "terminationRequested": True,
            "signal": "SIGTERM",
            "processGroupGone": group_gone,
            "partialOutputPublished": False,
            "exitCode": exit_code,
        },
        "publishedOutputFiles": [],
        "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
        "checkpointCount": len(checkpoint_lines),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--reference-evidence", required=True, type=Path)
    parser.add_argument("--evidence-root", required=True, type=Path)
    parser.add_argument("--startup-timeout-seconds", type=float, default=30)
    parser.add_argument("--cancel-after-checkpoint-seconds", type=float, default=1)
    parser.add_argument("--termination-timeout-seconds", type=float, default=10)
    args = parser.parse_args()
    payload = run(args)
    destination = args.evidence_root / "cancellation.json"
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
