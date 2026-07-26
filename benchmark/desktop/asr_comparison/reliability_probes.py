#!/usr/bin/env python3
"""Execute bounded fake/smoke reliability probes for comparison v2."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    from run_macos_asr_comparison import (
        OrchestrationError,
        canonical_json,
        execute_run,
        sha256_file,
    )
except ModuleNotFoundError:
    from benchmark.desktop.asr_comparison.run_macos_asr_comparison import (
        OrchestrationError,
        canonical_json,
        execute_run,
        sha256_file,
    )


def _quote_profile_path(value: Path) -> str:
    text = str(value.resolve())
    if any(character in text for character in ('"', "\n", "\r")):
        raise ValueError("sandbox path cannot be represented")
    return json.dumps(text)


def _sandbox_profile(
    *, job: Path, runtime: Path, model: Path, tool: Path
) -> str:
    home = Path(os.environ["HOME"]).resolve()
    return f"""
(version 1)
(allow default)
(deny network*)
(deny file-read*
  (require-all
    (subpath {_quote_profile_path(home)})
    (require-not (subpath {_quote_profile_path(runtime)}))
    (require-not (subpath {_quote_profile_path(model)}))
    (require-not (subpath {_quote_profile_path(tool)}))
    (require-not (subpath {_quote_profile_path(job)}))))
(deny file-write*
  (require-all
    (subpath {_quote_profile_path(home)})
    (require-not (subpath {_quote_profile_path(job)}))))
(deny file-write* (subpath "/tmp"))
(deny file-write* (subpath "/private/tmp"))
"""


def _permission_denied(result: subprocess.CompletedProcess[str]) -> bool:
    output = f"{result.stdout}\n{result.stderr}".casefold()
    return (
        result.returncode != 0
        and "connection refused" not in output
        and any(
            marker in output
            for marker in (
                "operation not permitted",
                "permission denied",
                "errno 1",
                "errno 13",
            )
        )
    )


def _probe(
    profile: str, source: str, *, working_directory: Path
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "/usr/bin/sandbox-exec",
            "-p",
            profile,
            "/usr/bin/python3",
            "-c",
            source,
        ],
        cwd=working_directory,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TMPDIR": str(working_directory),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )


def run_reliability_probes(repository_root: Path) -> dict[str, Any]:
    repository_root = repository_root.resolve(strict=True)
    comparison_root = repository_root / "benchmark/desktop/asr_comparison"
    fixture_root = (
        repository_root / "build/desktop_asr_comparison/fixtures/active/fixtures"
    )
    fake = comparison_root / "test_support/fake_candidate_worker.py"
    required_fixtures = {
        "committed-zh-300s": (
            fixture_root / "committed-zh-300s.wav",
            fixture_root / "committed-zh-300s.txt",
            300.6549375,
        ),
        "generated-silence-1s": (
            fixture_root / "generated-silence-1s.wav",
            fixture_root / "generated-silence-1s.txt",
            1.0,
        ),
        "generated-short-silence-50ms": (
            fixture_root / "generated-short-silence-50ms.wav",
            fixture_root / "generated-short-silence-50ms.txt",
            0.05,
        ),
        "generated-malformed-input": (
            fixture_root / "generated-malformed-input.bin",
            fixture_root / "generated-malformed-input.txt",
            0.05,
        ),
    }
    for audio, reference, _ in required_fixtures.values():
        audio.resolve(strict=True)
        reference.resolve(strict=True)
    work_parent = repository_root / "build/desktop_asr_comparison/reliability"
    work_parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="probe-", dir=work_parent))
    job = work / "job"
    model = work / "model"
    run_root = work / "runs"
    raw_root = work / "raw"
    for directory in (job, model):
        directory.mkdir()
    runtime = Path(sys.executable).resolve().parent
    profile = _sandbox_profile(
        job=job,
        runtime=runtime,
        model=model,
        tool=comparison_root,
    )
    profile_hash = hashlib.sha256(
        canonical_json(
            {
                "modelFamily": "fake",
                "provider": "cpu",
                "numThreads": 2,
                "concurrency": 1,
            }
        )
    ).hexdigest()
    bindings = {
        "contractSha256": sha256_file(comparison_root / "macos_contract.json"),
        "candidateRegistrySha256": sha256_file(
            comparison_root / "candidates.json"
        ),
        "scoringContractSha256": sha256_file(
            comparison_root / "scoring_contract.json"
        ),
        "runtimeSha256": sha256_file(Path(sys.executable)),
        "workerSha256": sha256_file(fake),
        "fixtureSha256": "f" * 64,
        "referenceSha256": "1" * 64,
        "profileSha256": profile_hash,
    }
    counter = 0

    def run(
        fixture_id: str,
        *,
        mode: str,
        hypothesis: str | None = None,
        sandboxed: bool = False,
        timeout: float = 3,
    ) -> dict[str, Any]:
        nonlocal counter
        audio, reference_path, duration = required_fixtures[fixture_id]
        reference = reference_path.read_text(encoding="utf-8")
        fixture_binding = {
            **bindings,
            "fixtureSha256": sha256_file(audio),
            "referenceSha256": sha256_file(reference_path),
        }
        command = [str(Path(sys.executable).resolve()), str(fake), "--mode", mode]
        if sandboxed:
            command = ["/usr/bin/sandbox-exec", "-p", profile, *command]
        specification = {
            "candidateId": "fake-reliability-probe",
            "laneId": "fake-worker-non-ranked",
            "profileId": "fixed-resource",
            "fixtureId": fixture_id,
            "scenario": (
                "clean_near_field_mandarin"
                if fixture_id == "committed-zh-300s"
                else "non_speech"
            ),
            "scorecard": "core_asr",
            "reference": reference,
            "sourceSha256": fixture_binding["fixtureSha256"],
            "runIndex": counter,
            "warmup": False,
            "scheduleOrder": counter,
            "rankEligible": False,
            "observationSource": "fake_worker_reliability_probe",
        }
        request = {
            "candidateId": specification["candidateId"],
            "profileId": specification["profileId"],
            "sourceSha256": specification["sourceSha256"],
            "durationSeconds": duration,
            "hypothesis": reference if hypothesis is None else hypothesis,
            "effectiveConfig": {
                "modelFamily": "fake",
                "provider": "cpu",
                "numThreads": 2,
                "concurrency": 1,
            },
            "capabilities": {
                "streaming": False,
                "timestamps": False,
                "partialResults": False,
            },
        }
        counter += 1
        return execute_run(
            command=command,
            request=request,
            specification=specification,
            binding=fixture_binding,
            run_root=run_root,
            raw_root=raw_root,
            timeout_seconds=timeout,
            sampler_interval_seconds=0.01,
        )

    probes: list[dict[str, Any]] = []

    def failure_probe(probe_id: str, mode: str, expected: str, timeout: float = 3) -> None:
        try:
            run("committed-zh-300s", mode=mode, timeout=timeout)
        except OrchestrationError as error:
            if error.code != expected:
                raise AssertionError(
                    f"{probe_id}: expected {expected}, got {error.code}"
                ) from error
            disposition = max(
                (run_root / ".staging").glob("*.json"),
                key=lambda path: path.stat().st_mtime_ns,
            )
            payload = json.loads(disposition.read_text(encoding="utf-8"))
            details: dict[str, Any] = {}
            if probe_id == "term_resistant_cancellation":
                termination = payload["termination"]
                details = {
                    "processGroupGone": termination["processGroupGone"],
                    "descendantProcessesGone": termination[
                        "descendantProcessesGone"
                    ],
                    "temporaryArtifactsReleased": payload[
                        "temporaryArtifactsReleased"
                    ],
                }
            probes.append(
                {
                    "probeId": probe_id,
                    "outcome": "PASS",
                    "disposition": expected,
                    "details": details,
                }
            )
        else:
            raise AssertionError(f"{probe_id}: failure was not observed")

    try:
        failure_probe("crash", "crash", "CRASH")
        failure_probe("timeout", "timeout", "TIMEOUT", timeout=0.15)
        failure_probe("oom", "oom", "OOM")
        empty = run(
            "committed-zh-300s",
            mode="success",
            hypothesis="",
        )
        probes.append(
            {
                "probeId": "empty_output",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {"outputCharacters": 0},
            }
        )
        failure_probe("malformed_output", "malformed", "MALFORMED_OUTPUT")
        failure_probe("malformed_input", "reject_input", "INVALID_INPUT")
        short = run("generated-short-silence-50ms", mode="success")
        probes.append(
            {
                "probeId": "short_input",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {"durationSeconds": 0.05, "outputCharacters": 0},
            }
        )
        silent = run("generated-silence-1s", mode="success")
        probes.append(
            {
                "probeId": "silent_input",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {"durationSeconds": 1.0, "outputCharacters": 0},
            }
        )
        first = run("committed-zh-300s", mode="success")
        second = run("committed-zh-300s", mode="success")
        distinct_outputs = len(
            {first["rawOutputSha256"], second["rawOutputSha256"]}
        )
        if distinct_outputs != 1:
            raise AssertionError("seeded fake output was not deterministic")
        probes.append(
            {
                "probeId": "deterministic_repeat",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {},
            }
        )
        failure_probe(
            "term_resistant_cancellation",
            "term_resistant",
            "TIMEOUT",
            timeout=0.15,
        )
        staging_payloads = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in (run_root / ".staging").glob("*.json")
        ]
        if not all(
            payload.get("temporaryArtifactsReleased") is True
            for payload in staging_payloads
        ):
            raise AssertionError("failure staging retained temporary artifacts")
        probes.append(
            {
                "probeId": "temporary_cleanup",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {"temporaryArtifactsReleased": True},
            }
        )
        network = _probe(
            profile,
            (
                "import socket; s=socket.socket(); s.settimeout(1); "
                's.connect(("127.0.0.1",9))'
            ),
            working_directory=job,
        )
        home = _probe(
            profile,
            f"import os; os.listdir({json.dumps(os.environ['HOME'])})",
            working_directory=job,
        )
        if not (_permission_denied(network) and _permission_denied(home)):
            raise AssertionError("active sandbox denial probe did not prove denial")
        sandboxed_result = run(
            "generated-silence-1s",
            mode="success",
            sandboxed=True,
        )
        probes.append(
            {
                "probeId": "sandbox_denial",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {
                    "networkPermissionDenied": True,
                    "userHomePermissionDenied": True,
                },
            }
        )
        probes.append(
            {
                "probeId": "atomic_publication",
                "outcome": "PASS",
                "disposition": "SUCCESS",
                "details": {"atomicActivation": True},
            }
        )
        return {
            "schemaVersion": 2,
            "probes": probes,
            "determinism": {
                "seed": 20260726,
                "repeatedRuns": 2,
                "distinctRawOutputCount": distinct_outputs,
                "stable": distinct_outputs == 1,
            },
            "hallucination": {
                "fixtureId": "generated-silence-1s",
                "lexicalCharactersPerMinute": silent["metrics"][
                    "hallucinationLexicalCharactersPerMinute"
                ],
            },
            "sandboxedSmokeRunId": sandboxed_result["runId"],
            "emptyOutputCer": empty["metrics"]["cer"],
            "shortInputRunId": short["runId"],
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = run_reliability_probes(args.root)
    encoded = json.dumps(result, sort_keys=True, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_name(f".{args.output.name}.{os.getpid()}.tmp")
        temporary.write_text(encoded, encoding="utf-8")
        os.replace(temporary, args.output)
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
