#!/usr/bin/env python3

import argparse
import os
import pathlib
import re
import subprocess
from typing import Callable, NamedTuple


GIB = 1024**3
DEFAULT_LIMIT_GIB = 20.0
MANAGED_CACHE_PATHS = (
    ("build", pathlib.Path("build")),
    (".dart_tool/flutter_build", pathlib.Path(".dart_tool/flutter_build")),
    ("android/.gradle", pathlib.Path("android/.gradle")),
)
BUILD_PROCESS_PATTERN = re.compile(
    r"(^|[/\s])(cargo|rustc|flutter|gradle|gradlew|xcodebuild)(\s|$)"
)


class CacheUsage(NamedTuple):
    parts: dict[str, int]
    total_bytes: int


class GuardResult(NamedTuple):
    usage: CacheUsage
    cleaned: bool
    would_clean: bool


def active_build_processes() -> list[str]:
    result = subprocess.run(
        ["ps", "ax", "-o", "pid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    current_pid = os.getpid()
    active = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        if int(fields[0]) == current_pid:
            continue
        if BUILD_PROCESS_PATTERN.search(fields[1]):
            active.append(line.strip())
    return active


def directory_size_bytes(path: pathlib.Path) -> int:
    if not path.exists():
        return 0
    result = subprocess.run(
        ["du", "-sk", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.split()[0]) * 1024


def managed_cache_usage(
    root: pathlib.Path,
    *,
    size_reader: Callable[[pathlib.Path], int] = directory_size_bytes,
) -> CacheUsage:
    parts = {
        label: size_reader(root / relative_path)
        for label, relative_path in MANAGED_CACHE_PATHS
    }
    return CacheUsage(parts, sum(parts.values()))


def enforce_budget(
    root: pathlib.Path,
    *,
    limit_bytes: int,
    force: bool = False,
    dry_run: bool = False,
    usage_reader: Callable[[pathlib.Path], CacheUsage] = managed_cache_usage,
    active_process_reader: Callable[[], list[str]] = active_build_processes,
    command_runner: Callable[..., object] = subprocess.run,
) -> GuardResult:
    if limit_bytes < 0:
        raise ValueError("limit_bytes must be non-negative")

    usage = usage_reader(root)
    should_clean = force or usage.total_bytes > limit_bytes
    if not should_clean:
        return GuardResult(usage, cleaned=False, would_clean=False)
    if dry_run:
        return GuardResult(usage, cleaned=False, would_clean=True)

    active = active_process_reader()
    if active:
        raise RuntimeError(
            "refusing to clean while build processes are active:\n"
            + "\n".join(f"  {process}" for process in active)
        )

    command_runner(["flutter", "clean"], cwd=root, check=True)
    command_runner(
        [
            "bash",
            "scripts/clean_flutter_android_artifacts.sh",
            "--run",
            "--yes",
        ],
        cwd=root,
        check=True,
    )
    return GuardResult(usage, cleaned=True, would_clean=False)


def format_gib(size_bytes: int) -> str:
    return f"{size_bytes / GIB:.2f} GiB"


def project_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent


def parse_limit_gib(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def validate_root(root: pathlib.Path) -> None:
    required = (
        root / "pubspec.yaml",
        root / "scripts" / "clean_flutter_android_artifacts.sh",
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(f"error: invalid project root; missing {', '.join(missing)}")


def print_usage(usage: CacheUsage, limit_bytes: int) -> None:
    print(
        f"Managed build cache: {format_gib(usage.total_bytes)} "
        f"(limit {format_gib(limit_bytes)})"
    )
    for label, size_bytes in usage.parts.items():
        print(f"  {label}: {format_gib(size_bytes)}")


def main() -> int:
    default_limit = os.environ.get(
        "VOICE2TEXT_BUILD_CACHE_LIMIT_GIB",
        str(DEFAULT_LIMIT_GIB),
    )
    parser = argparse.ArgumentParser(
        description=(
            "Clean generated Flutter and Android artifacts only when their "
            "combined disk use exceeds a configured budget."
        )
    )
    parser.add_argument(
        "--limit-gib",
        type=parse_limit_gib,
        default=parse_limit_gib(default_limit),
        help=(
            "cache budget in GiB "
            f"(default: {DEFAULT_LIMIT_GIB:g}, "
            "env: VOICE2TEXT_BUILD_CACHE_LIMIT_GIB)"
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="clean managed generated artifacts regardless of current size",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report whether cleanup would run without changing files",
    )
    args = parser.parse_args()

    root = project_root()
    validate_root(root)
    limit_bytes = int(args.limit_gib * GIB)
    try:
        result = enforce_budget(
            root,
            limit_bytes=limit_bytes,
            force=args.force,
            dry_run=args.dry_run,
        )
    except RuntimeError as error:
        print(f"error: {error}")
        return 2
    print_usage(result.usage, limit_bytes)
    if result.cleaned:
        print("Build cache was cleaned.")
    elif result.would_clean:
        print("Build cache would be cleaned.")
    else:
        print("Build cache is within budget; no cleanup needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
