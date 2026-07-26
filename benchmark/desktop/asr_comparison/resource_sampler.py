#!/usr/bin/env python3
"""Sample RSS/CPU/thread/temp-disk usage for an isolated process tree."""

from __future__ import annotations

import math
import threading
import time
from pathlib import Path
from typing import Any

import psutil


class ResourceSamplerError(RuntimeError):
    pass


class ProcessTreeSampler:
    def __init__(
        self,
        root_pid: int,
        *,
        interval_seconds: float = 0.05,
        temporary_root: Path | None = None,
    ) -> None:
        if (
            interval_seconds <= 0
            or not math.isfinite(interval_seconds)
            or interval_seconds > 1
        ):
            raise ValueError("sampler interval must be finite and in (0, 1]")
        self.root_pid = root_pid
        self.interval_seconds = interval_seconds
        self.temporary_root = temporary_root
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._lock = threading.Lock()
        self._samples: list[dict[str, Any]] = []
        self._baseline_rss: int | None = None
        self._retained_rss: int | None = None
        self._retained_rss_source: str | None = None
        self._missed_processes = 0
        self._observed_pids: set[int] = set()
        self._tracked_processes: dict[int, float] = {}

    def start(self) -> None:
        self._sample()
        self._thread.start()

    def freeze_baseline(self, *, settle_intervals: int = 1) -> int:
        if settle_intervals < 1 or settle_intervals > 20:
            raise ValueError("baseline settle interval count is invalid")
        time.sleep(self.interval_seconds * settle_intervals)
        sample = self._sample()
        with self._lock:
            self._baseline_rss = int(sample["rssBytes"])
        return self._baseline_rss

    def track_process(self, process_id: int) -> None:
        if not isinstance(process_id, int) or isinstance(process_id, bool) or process_id <= 0:
            raise ValueError("tracked process id is invalid")
        try:
            process = psutil.Process(process_id)
            created_at = process.create_time()
        except (psutil.NoSuchProcess, psutil.AccessDenied) as error:
            raise ResourceSamplerError(
                f"tracked process {process_id} is unavailable"
            ) from error
        with self._lock:
            self._tracked_processes[process_id] = created_at

    def mark_unload_complete(
        self,
        *,
        settle_intervals: int = 1,
        worker_reported_rss_bytes: int | None = None,
    ) -> int:
        if settle_intervals < 1 or settle_intervals > 20:
            raise ValueError("unload settle interval count is invalid")
        if (
            worker_reported_rss_bytes is not None
            and (
                not isinstance(worker_reported_rss_bytes, int)
                or isinstance(worker_reported_rss_bytes, bool)
                or worker_reported_rss_bytes < 0
            )
        ):
            raise ValueError("worker-reported retained RSS is invalid")
        time.sleep(self.interval_seconds * settle_intervals)
        sample = self._sample()
        sampled_rss = int(sample["rssBytes"])
        retained_rss = max(sampled_rss, worker_reported_rss_bytes or 0)
        with self._lock:
            self._retained_rss = retained_rss
            self._retained_rss_source = (
                "worker_self_report"
                if worker_reported_rss_bytes is not None
                and worker_reported_rss_bytes > sampled_rss
                else "process_tree_sample"
            )
        return self._retained_rss

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=max(1.0, self.interval_seconds * 4))
        self._sample()
        with self._lock:
            samples = list(self._samples)
            baseline = self._baseline_rss
            retained = self._retained_rss
            retained_source = self._retained_rss_source
            missed = self._missed_processes
            observed = set(self._observed_pids)
        if not samples:
            raise ResourceSamplerError("resource sampler produced no samples")
        absolute_peak = max(int(sample["rssBytes"]) for sample in samples)
        cpu_user = max(float(sample["cpuUserSeconds"]) for sample in samples)
        cpu_system = max(float(sample["cpuSystemSeconds"]) for sample in samples)
        return {
            "schemaVersion": 2,
            "intervalMilliseconds": round(self.interval_seconds * 1000, 3),
            "sampleCount": len(samples),
            "baselineRssBytes": baseline,
            "absolutePeakRssBytes": absolute_peak,
            "incrementalPeakRssBytes": (
                max(0, absolute_peak - baseline) if baseline is not None else None
            ),
            "retainedRssBytesAfterUnload": retained,
            "retainedRssMeasurementSource": retained_source,
            "cpuUserSeconds": cpu_user,
            "cpuSystemSeconds": cpu_system,
            "observedProcessCount": len(observed),
            "maximumConcurrentProcessCount": max(
                int(sample["processCount"]) for sample in samples
            ),
            "maximumThreadCount": max(
                int(sample["threadCount"]) for sample in samples
            ),
            "temporaryDiskPeakBytes": max(
                int(sample["temporaryDiskBytes"]) for sample in samples
            ),
            "missedOrExitedProcessObservations": missed,
        }

    def _loop(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self._sample()

    def _sample(self) -> dict[str, Any]:
        rss = 0
        cpu_user = 0.0
        cpu_system = 0.0
        thread_count = 0
        process_count = 0
        observed: set[int] = set()
        try:
            root = psutil.Process(self.root_pid)
            processes = [root, *root.children(recursive=True)]
        except psutil.NoSuchProcess:
            processes = []
            with self._lock:
                self._missed_processes += 1
        with self._lock:
            tracked_processes = dict(self._tracked_processes)
        known_process_ids = {process.pid for process in processes}
        for process_id, created_at in tracked_processes.items():
            if process_id in known_process_ids:
                continue
            try:
                process = psutil.Process(process_id)
                if process.create_time() != created_at:
                    with self._lock:
                        self._missed_processes += 1
                    continue
                processes.append(process)
                known_process_ids.add(process_id)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                with self._lock:
                    self._missed_processes += 1
        for process in processes:
            try:
                with process.oneshot():
                    rss += process.memory_info().rss
                    cpu = process.cpu_times()
                    cpu_user += cpu.user
                    cpu_system += cpu.system
                    thread_count += process.num_threads()
                    process_count += 1
                    observed.add(process.pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied, ProcessLookupError):
                with self._lock:
                    self._missed_processes += 1
        temporary_disk = (
            _directory_bytes(self.temporary_root)
            if self.temporary_root is not None
            else 0
        )
        sample = {
            "monotonicSeconds": time.monotonic(),
            "rssBytes": rss,
            "cpuUserSeconds": cpu_user,
            "cpuSystemSeconds": cpu_system,
            "threadCount": thread_count,
            "processCount": process_count,
            "temporaryDiskBytes": temporary_disk,
        }
        with self._lock:
            self._samples.append(sample)
            self._observed_pids.update(observed)
        return sample


def _directory_bytes(root: Path) -> int:
    try:
        return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
    except FileNotFoundError:
        return 0
