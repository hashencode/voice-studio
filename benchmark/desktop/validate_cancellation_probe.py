#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def validate(path: Path) -> None:
    evidence = json.loads(path.read_text())
    if evidence.get("schemaVersion") != 1:
        raise ValueError("unsupported cancellation probe schema")
    if evidence.get("source") != "macos_native_sherpa_worker":
        raise ValueError("cancellation probe source mismatch")
    if evidence.get("complete") is not False:
        raise ValueError("cancellation probe must not claim completion")
    if evidence.get("timedOut") is not True:
        raise ValueError("worker timeout was not observed")
    if evidence.get("cancelled") is not True:
        raise ValueError("worker cancellation was not observed")
    if evidence.get("temporaryArtifactsReleased") is not True:
        raise ValueError("temporary artifacts were not released")
    if evidence.get("nativeProgressCallbackCancellationSupported") is not False:
        raise ValueError("progress callback must not be represented as cancellable")
    if evidence.get("nativeCallbackReturnValueDisposition") != "ignored_by_sherpa_1_13_4":
        raise ValueError("native callback disposition is missing")
    worker = evidence.get("workerTermination")
    if not isinstance(worker, dict):
        raise ValueError("worker termination evidence is missing")
    expected = {
        "boundary": "separate_process_group",
        "nativeCheckpoint": "native_diarizer_initialized",
        "terminationRequested": True,
        "signal": "SIGTERM",
        "processGroupGone": True,
        "partialOutputPublished": False,
    }
    for key, value in expected.items():
        if worker.get(key) != value:
            raise ValueError(f"worker termination field invalid: {key}")
    if not isinstance(worker.get("exitCode"), int) or worker["exitCode"] == 0:
        raise ValueError("worker did not exit through cancellation")
    if evidence.get("publishedOutputFiles") != []:
        raise ValueError("partial speaker output escaped cancellation")
    fingerprint = evidence.get("targetFingerprint")
    required_fingerprint = {
        "operatingSystem", "operatingSystemVersion", "architecture", "cpuModel",
        "logicalCpuCount", "memoryBytes", "runtimeId", "runtimeVersion",
        "runtimeSha256",
    }
    if not isinstance(fingerprint, dict) or set(fingerprint) != required_fingerprint:
        raise ValueError("target fingerprint is incomplete")
    if fingerprint.get("operatingSystem") != "macos":
        raise ValueError("cancellation evidence is not from macOS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate(args.evidence)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"cancellation probe invalid: {error}")
        return 1
    print("cancellation probe: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
