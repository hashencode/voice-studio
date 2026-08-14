from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tool/run_electron_desktop_gate.py"


class ElectronDesktopGateRunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.temporary.name)
        self.definition = self.root / "definition.txt"
        self.definition.write_text("gate definition\n", encoding="utf-8")
        self.receipt = self.root / "receipt.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _relative(self, path: Path) -> str:
        return path.relative_to(ROOT).as_posix()

    def test_success_writes_bound_privacy_safe_receipt(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--cwd",
                str(ROOT),
                "--deadline-epoch-ms",
                str(int(time.time() * 1000) + 10_000),
                "--command-id",
                "test-gate",
                "--source-revision",
                "a" * 40,
                "--relevant-source-sha256",
                "b" * 64,
                "--target-sha256",
                "c" * 64,
                "--package-sha256",
                "d" * 64,
                "--binding",
                f"gate-test:{self._relative(self.definition)}:{self._relative(self.receipt)}",
                "--",
                sys.executable,
                "-c",
                "raise SystemExit(0)",
            ],
            cwd=ROOT,
            check=False,
        )
        self.assertEqual(0, result.returncode)
        receipt = json.loads(self.receipt.read_text(encoding="utf-8"))
        self.assertEqual("PASS", receipt["status"])
        self.assertEqual(0, receipt["exitCode"])
        self.assertEqual(
            hashlib.sha256(self.definition.read_bytes()).hexdigest(),
            receipt["definitionSha256"],
        )
        self.assertNotIn("command", receipt)

    def test_failure_does_not_write_receipt(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--cwd",
                str(ROOT),
                "--deadline-epoch-ms",
                str(int(time.time() * 1000) + 10_000),
                "--command-id",
                "test-failure",
                "--",
                sys.executable,
                "-c",
                "raise SystemExit(7)",
            ],
            cwd=ROOT,
            check=False,
        )
        self.assertEqual(7, result.returncode)
        self.assertFalse(self.receipt.exists())

    def test_deadline_terminates_child_process_group(self) -> None:
        pid_path = self.root / "child.pid"
        script = (
            "import pathlib,subprocess; "
            "child=subprocess.Popen(['/bin/sleep','30']); "
            f"pathlib.Path({str(pid_path)!r}).write_text(str(child.pid)); "
            "child.wait()"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--cwd",
                str(ROOT),
                "--deadline-epoch-ms",
                str(int(time.time() * 1000) + 500),
                "--command-id",
                "test-timeout",
                "--",
                sys.executable,
                "-c",
                script,
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(124, result.returncode)
        child_pid = int(pid_path.read_text(encoding="utf-8"))
        for _ in range(40):
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("deadline left a child process running")


if __name__ == "__main__":
    unittest.main()
