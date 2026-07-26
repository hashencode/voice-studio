#!/usr/bin/env python3
"""Launch a processing sidecar with a minimal environment and hard limits."""

from __future__ import annotations

import argparse
import errno
import os
import resource
from pathlib import Path


def existing_root(value: str, label: str) -> Path:
    root = Path(value).resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"{label} must be a directory")
    return root


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-root", required=True)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--engine", required=True, choices=("funasr", "pyannote"))
    parser.add_argument("--cpu-seconds", type=int, default=14400)
    parser.add_argument("--memory-bytes", type=int, default=6 * 1024**3)
    parser.add_argument("--output-bytes", type=int, default=64 * 1024**2)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command or args.command[0] != "--" or len(args.command) < 2:
        parser.error("sidecar command must follow --")

    job_root = existing_root(args.job_root, "job root")
    runtime_root = existing_root(args.runtime_root, "runtime root")
    model_root = existing_root(args.model_root, "model root")
    for private in ("home", "tmp"):
        (job_root / private).mkdir(mode=0o700, exist_ok=True)

    limits = (
        (resource.RLIMIT_CPU, args.cpu_seconds),
        (resource.RLIMIT_FSIZE, args.output_bytes),
        (resource.RLIMIT_NOFILE, 128),
        (resource.RLIMIT_CORE, 0),
    )
    for kind, limit in limits:
        _, hard_limit = resource.getrlimit(kind)
        resource.setrlimit(kind, (limit, hard_limit))
    try:
        os.setsid()
    except OSError as error:
        if error.errno != errno.EPERM:
            raise

    python_bin = runtime_root / "bin"
    environment = {
        "HOME": str(job_root / "home"),
        "TMPDIR": str(job_root / "tmp"),
        "PATH": f"{python_bin}:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "MODELSCOPE_CACHE": str(model_root),
        "SIDECAR_ENGINE": args.engine,
        "SIDECAR_JOB_ROOT": str(job_root),
        "SIDECAR_RUNTIME_ROOT": str(runtime_root),
        "SIDECAR_MODEL_ROOT": str(model_root),
    }
    executable = args.command[1]
    os.execve(executable, args.command[1:], environment)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
