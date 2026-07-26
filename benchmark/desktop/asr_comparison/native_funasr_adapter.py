#!/usr/bin/env python3
"""Locked native FunASR control adapter for short, cross-runtime observations."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

try:
    from run_macos_asr_comparison import (
        OrchestrationError,
        canonical_json,
        native_control_observation_envelope,
        sha256_file,
    )
except ModuleNotFoundError:
    from benchmark.desktop.asr_comparison.run_macos_asr_comparison import (
        OrchestrationError,
        canonical_json,
        native_control_observation_envelope,
        sha256_file,
    )


ALLOWED_STAGES = {"STAGE_0_ADMISSION", "STAGE_1_SHORT"}


def adapt_native_result(
    result: dict[str, Any],
    *,
    stage_id: str,
    candidate_id: str,
    fixture_id: str,
    profile_id: str,
) -> dict[str, Any]:
    if stage_id not in ALLOWED_STAGES:
        raise OrchestrationError(
            "NATIVE_STAGE_FORBIDDEN", "native FunASR is limited to short controls"
        )
    metrics = result.get("metrics")
    if not isinstance(metrics, dict):
        raise OrchestrationError(
            "MALFORMED_NATIVE_RESULT", "native metrics are missing"
        )
    raw_hash = hashlib.sha256(canonical_json(result)).hexdigest()
    return native_control_observation_envelope(
        candidate_id=candidate_id,
        fixture_id=fixture_id,
        profile_id=profile_id,
        raw_output_sha256=raw_hash,
        metrics=metrics,
    )


def run_locked_adapter(
    *,
    interpreter: Path,
    environment_lock: Path,
    runner: Path,
    runner_arguments: list[str],
    output: Path,
) -> dict[str, Any]:
    interpreter.resolve(strict=True)
    runner.resolve(strict=True)
    environment_lock.resolve(strict=True)
    expected_runtime_hash = sha256_file(environment_lock)
    command = [
        str(interpreter),
        str(runner),
        *runner_arguments,
        "--environment-lock",
        str(environment_lock),
        "--output",
        str(output),
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "HF_HUB_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "MODELSCOPE_OFFLINE": "1",
        },
    )
    if completed.returncode != 0:
        raise OrchestrationError(
            "NATIVE_ADAPTER_FAILURE",
            f"locked native adapter exited {completed.returncode}",
            details={
                "environmentLockSha256": expected_runtime_hash,
                "stderrSha256": hashlib.sha256(completed.stderr.encode()).hexdigest(),
            },
        )
    result = json.loads(output.read_text(encoding="utf-8"))
    environment = result.get("environment")
    if (
        not isinstance(environment, dict)
        or environment.get("environmentLockSha256") != expected_runtime_hash
    ):
        raise OrchestrationError(
            "NATIVE_RUNTIME_MISMATCH", "native adapter runtime lock changed"
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--stage-id", required=True)
    parser.add_argument(
        "--candidate-id",
        default="native-funasr-1.3.22-paraformer-vad-punctuation",
    )
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--profile-id", default="recommended")
    args = parser.parse_args()
    result = json.loads(args.input.read_text(encoding="utf-8"))
    envelope = adapt_native_result(
        result,
        stage_id=args.stage_id,
        candidate_id=args.candidate_id,
        fixture_id=args.fixture_id,
        profile_id=args.profile_id,
    )
    print(json.dumps(envelope, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
