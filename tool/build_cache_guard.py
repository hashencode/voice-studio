#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
import os
import pathlib
import re
import shutil
import subprocess
import time
from typing import Callable, NamedTuple


GIB = 1024**3
DEFAULT_LIMIT_GIB = 8.0
BUILD_PROCESS_PATTERN = re.compile(
    r"(^|[/\s])"
    r"(dart|flutter(?:_tester|_tools\.snapshot)?|gradle|gradlew|xcodebuild|"
    r"org\.gradle\.wrapper\.GradleWrapperMain)"
    r"([/\s]|$)"
)


class FlutterProject(NamedTuple):
    relative_path: pathlib.Path
    cache_limit_gib: float
    clean_android_gradle: bool = False


FLUTTER_PROJECTS = (
    FlutterProject(
        pathlib.Path("apps/mobile-flutter"),
        cache_limit_gib=7.0,
        clean_android_gradle=True,
    ),
    FlutterProject(pathlib.Path("packages/audio_core"), cache_limit_gib=0.5),
    FlutterProject(
        pathlib.Path("packages/audio_storage"),
        cache_limit_gib=0.5,
    ),
    FlutterProject(
        pathlib.Path("packages/audio_workflows"),
        cache_limit_gib=0.5,
    ),
    FlutterProject(
        pathlib.Path("packages/companion_protocol"),
        cache_limit_gib=0.5,
    ),
    FlutterProject(
        pathlib.Path("packages/desktop_sherpa_worker"),
        cache_limit_gib=0.5,
    ),
    FlutterProject(
        pathlib.Path("packages/processing_contracts"),
        cache_limit_gib=0.5,
    ),
)


class CacheUsage(NamedTuple):
    parts: dict[str, int]
    total_bytes: int


class GuardResult(NamedTuple):
    usage: CacheUsage
    cleaned: bool
    would_clean: bool
    deferred: bool
    active_processes: tuple[str, ...]
    remaining_usage: CacheUsage | None


def running_processes() -> list[tuple[int, str]]:
    result = subprocess.run(
        ["ps", "ax", "-o", "pid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    current_pid = os.getpid()
    processes = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        pid = int(fields[0])
        if pid == current_pid:
            continue
        processes.append((pid, fields[1]))
    return processes


def process_cwd(pid: int) -> pathlib.Path | None:
    result = subprocess.run(
        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        check=False,
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("n") and len(line) > 1:
            return pathlib.Path(line[1:])
    return None


def is_within(path: pathlib.Path, root: pathlib.Path) -> bool:
    resolved_path = path.resolve()
    resolved_root = root.resolve()
    return resolved_path == resolved_root or resolved_root in resolved_path.parents


def active_build_processes(
    root: pathlib.Path,
    *,
    process_reader: Callable[[], list[tuple[int, str]]] = running_processes,
    cwd_reader: Callable[[int], pathlib.Path | None] = process_cwd,
) -> list[str]:
    resolved_root = root.resolve()
    active = []
    for pid, command in process_reader():
        if not BUILD_PROCESS_PATTERN.search(command):
            continue
        cwd = cwd_reader(pid)
        if str(resolved_root) in command or (
            cwd is not None and is_within(cwd, resolved_root)
        ):
            active.append(f"{pid} {command}")
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


def remove_directory_tree(path: pathlib.Path) -> None:
    if path.is_symlink():
        raise RuntimeError(f"refusing to remove symbolic link: {path}")
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def cache_label(project: FlutterProject, relative_path: pathlib.Path) -> str:
    return (project.relative_path / relative_path).as_posix()


def managed_cache_paths(
    root: pathlib.Path,
) -> tuple[tuple[str, pathlib.Path], ...]:
    paths = []
    for project in FLUTTER_PROJECTS:
        project_root = root / project.relative_path
        for relative_path in (pathlib.Path("build"), pathlib.Path(".dart_tool")):
            paths.append(
                (
                    cache_label(project, relative_path),
                    project_root / relative_path,
                )
            )
        if project.clean_android_gradle:
            relative_path = pathlib.Path("android/.gradle")
            paths.append(
                (
                    cache_label(project, relative_path),
                    project_root / relative_path,
                )
            )
    return tuple(paths)


def managed_cache_usage(
    root: pathlib.Path,
    *,
    size_reader: Callable[[pathlib.Path], int] = directory_size_bytes,
) -> CacheUsage:
    parts = {
        label: size_reader(path)
        for label, path in managed_cache_paths(root)
    }
    return CacheUsage(parts, sum(parts.values()))


def project_usage_bytes(
    usage: CacheUsage,
    project: FlutterProject,
) -> int:
    relative_paths = [pathlib.Path("build"), pathlib.Path(".dart_tool")]
    if project.clean_android_gradle:
        relative_paths.append(pathlib.Path("android/.gradle"))
    return sum(
        usage.parts.get(cache_label(project, relative_path), 0)
        for relative_path in relative_paths
    )


def default_project_limits_bytes(
    override_gib: float | None = None,
) -> dict[pathlib.Path, int]:
    return {
        project.relative_path: int(
            (
                override_gib
                if override_gib is not None
                else project.cache_limit_gib
            )
            * GIB
        )
        for project in FLUTTER_PROJECTS
    }


def over_budget_projects(
    usage: CacheUsage,
    project_limits: dict[pathlib.Path, int],
) -> tuple[FlutterProject, ...]:
    return tuple(
        project
        for project in FLUTTER_PROJECTS
        if project_usage_bytes(usage, project)
        > project_limits[project.relative_path]
    )


def enforce_budget(
    root: pathlib.Path,
    *,
    limit_bytes: int,
    project_limits: dict[pathlib.Path, int] | None = None,
    force: bool = False,
    dry_run: bool = False,
    wait_for_idle: bool = False,
    wait_timeout_seconds: float = 1800,
    poll_interval_seconds: float = 5,
    usage_reader: Callable[[pathlib.Path], CacheUsage] = managed_cache_usage,
    active_process_reader: Callable[[], list[str]] | None = None,
    command_runner: Callable[..., object] = subprocess.run,
    remove_tree: Callable[[pathlib.Path], None] = remove_directory_tree,
    monotonic_reader: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
) -> GuardResult:
    if limit_bytes < 0:
        raise ValueError("limit_bytes must be non-negative")
    if project_limits is not None and any(
        limit < 0 for limit in project_limits.values()
    ):
        raise ValueError("project limits must be non-negative")
    if wait_timeout_seconds < 0:
        raise ValueError("wait_timeout_seconds must be non-negative")
    if poll_interval_seconds <= 0:
        raise ValueError("poll_interval_seconds must be positive")

    usage = usage_reader(root)
    exceeded_projects = (
        over_budget_projects(usage, project_limits)
        if project_limits is not None
        else ()
    )
    should_clean = (
        force
        or usage.total_bytes > limit_bytes
        or bool(exceeded_projects)
    )
    if not should_clean:
        return GuardResult(
            usage,
            cleaned=False,
            would_clean=False,
            deferred=False,
            active_processes=(),
            remaining_usage=None,
        )
    if dry_run:
        return GuardResult(
            usage,
            cleaned=False,
            would_clean=True,
            deferred=False,
            active_processes=(),
            remaining_usage=None,
        )

    process_reader = active_process_reader or (
        lambda: active_build_processes(root)
    )
    active = process_reader()
    if active and wait_for_idle:
        deadline = monotonic_reader() + wait_timeout_seconds
        while active:
            remaining_seconds = deadline - monotonic_reader()
            if remaining_seconds <= 0:
                break
            sleeper(min(poll_interval_seconds, remaining_seconds))
            active = process_reader()
    if active:
        return GuardResult(
            usage,
            cleaned=False,
            would_clean=False,
            deferred=True,
            active_processes=tuple(active),
            remaining_usage=None,
        )

    for project in FLUTTER_PROJECTS:
        command_runner(
            ["flutter", "clean"],
            cwd=root / project.relative_path,
            check=True,
        )

    for project in FLUTTER_PROJECTS:
        if project.clean_android_gradle:
            remove_tree(
                root
                / project.relative_path
                / "android"
                / ".gradle"
            )

    command_runner(
        ["flutter", "pub", "get", "--enforce-lockfile"],
        cwd=root,
        check=True,
    )

    return GuardResult(
        usage,
        cleaned=True,
        would_clean=False,
        deferred=False,
        active_processes=(),
        remaining_usage=usage_reader(root),
    )


def format_gib(size_bytes: int) -> str:
    return f"{size_bytes / GIB:.2f} GiB"


def project_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent


def parse_non_negative_number(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be finite and non-negative")
    return parsed


def validate_repository(root: pathlib.Path) -> None:
    root = root.resolve()
    missing = []
    for project in FLUTTER_PROJECTS:
        project_path = root / project.relative_path
        if project_path.is_symlink():
            raise SystemExit(
                f"error: project path must not be a symbolic link: {project_path}"
            )
        try:
            project_path.resolve().relative_to(root)
        except ValueError as error:
            raise SystemExit(
                f"error: project path escapes repository root: {project_path}"
            ) from error
        pubspec = project_path / "pubspec.yaml"
        if not pubspec.is_file():
            missing.append(str(pubspec))

    if missing:
        raise SystemExit(
            f"error: invalid repository root; missing {', '.join(missing)}"
        )

    for _, cache_path in managed_cache_paths(root):
        if cache_path.is_symlink():
            raise SystemExit(
                f"error: cache path must not be a symbolic link: {cache_path}"
            )


def print_usage(
    usage: CacheUsage,
    limit_bytes: int,
    project_limits: dict[pathlib.Path, int],
) -> None:
    print(
        f"Managed build cache: {format_gib(usage.total_bytes)} "
        f"(limit {format_gib(limit_bytes)})"
    )
    print("Project usage:")
    for project in FLUTTER_PROJECTS:
        relative_path = project.relative_path
        project_usage = project_usage_bytes(usage, project)
        project_limit = project_limits[relative_path]
        suffix = " [over budget]" if project_usage > project_limit else ""
        print(
            f"  {relative_path.as_posix()}: {format_gib(project_usage)} "
            f"(limit {format_gib(project_limit)}){suffix}"
        )
    print("Managed directories:")
    for label, size_bytes in usage.parts.items():
        print(f"  {label}: {format_gib(size_bytes)}")


def main() -> int:
    default_limit = os.environ.get(
        "VOICE2TEXT_BUILD_CACHE_LIMIT_GIB",
        str(DEFAULT_LIMIT_GIB),
    )
    default_project_limit = os.environ.get(
        "VOICE2TEXT_BUILD_CACHE_PROJECT_LIMIT_GIB"
    )
    parser = argparse.ArgumentParser(
        description=(
            "Clean generated artifacts across every Flutter project in this "
            "repository only when their disk use exceeds measured budgets."
        )
    )
    parser.add_argument(
        "--limit-gib",
        type=parse_non_negative_number,
        default=parse_non_negative_number(default_limit),
        help=(
            "repository cache budget in GiB "
            f"(default: {DEFAULT_LIMIT_GIB:g}, "
            "env: VOICE2TEXT_BUILD_CACHE_LIMIT_GIB)"
        ),
    )
    parser.add_argument(
        "--project-limit-gib",
        type=parse_non_negative_number,
        default=(
            parse_non_negative_number(default_project_limit)
            if default_project_limit is not None
            else None
        ),
        help=(
            "uniform per-project cache budget override in GiB "
            "(default: measured limits, env: "
            "VOICE2TEXT_BUILD_CACHE_PROJECT_LIMIT_GIB)"
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
    parser.add_argument(
        "--wait-for-idle",
        action="store_true",
        help="wait for this repository's active builds before cleaning",
    )
    parser.add_argument(
        "--wait-timeout-seconds",
        type=parse_non_negative_number,
        default=1800.0,
        help="maximum wait for --wait-for-idle (default: 1800)",
    )
    args = parser.parse_args()

    root = project_root()
    validate_repository(root)
    limit_bytes = int(args.limit_gib * GIB)
    project_limits = default_project_limits_bytes(args.project_limit_gib)
    result = enforce_budget(
        root,
        limit_bytes=limit_bytes,
        project_limits=project_limits,
        force=args.force,
        dry_run=args.dry_run,
        wait_for_idle=args.wait_for_idle,
        wait_timeout_seconds=args.wait_timeout_seconds,
    )

    print_usage(result.usage, limit_bytes, project_limits)
    if result.cleaned:
        assert result.remaining_usage is not None
        reclaimed = result.usage.total_bytes - result.remaining_usage.total_bytes
        print(
            "Build cache was cleaned; "
            f"{format_gib(max(reclaimed, 0))} reclaimed and "
            f"{format_gib(result.remaining_usage.total_bytes)} remains."
        )
    elif result.deferred:
        print("Build cache cleanup was deferred while this repository is busy:")
        for process in result.active_processes:
            print(f"  {process}")
    elif result.would_clean:
        print("Build cache would be cleaned.")
    else:
        print("Build cache is within budget; no cleanup needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
