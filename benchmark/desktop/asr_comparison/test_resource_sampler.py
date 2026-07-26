from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from resource_sampler import ProcessTreeSampler


ROOT = Path(__file__).resolve().parent
FAKE = ROOT / "test_support/fake_candidate_worker.py"


def request() -> dict:
    return {
        "candidateId": "fake-sampler-candidate",
        "profileId": "fixed-resource",
        "sourceSha256": "a" * 64,
        "durationSeconds": 1.0,
        "hypothesis": "",
        "memoryBytes": 32 * 1024 * 1024,
        "effectiveConfig": {"numThreads": 2},
        "capabilities": {},
    }


class ResourceSamplerTest(unittest.TestCase):
    def test_process_tree_peak_includes_memory_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            process = subprocess.Popen(
                [sys.executable, str(FAKE), "--mode", "child_memory"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(json.dumps(request()) + "\n")
            process.stdin.flush()
            handshake = json.loads(process.stdout.readline())
            self.assertEqual(handshake["type"], "handshake")
            sampler = ProcessTreeSampler(
                process.pid,
                interval_seconds=0.02,
                temporary_root=Path(temporary),
            )
            sampler.start()
            baseline = sampler.freeze_baseline()
            process.stdin.write(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "type": "baselineFrozen",
                        "candidateId": handshake["candidateId"],
                        "profileId": handshake["profileId"],
                        "sourceSha256": handshake["sourceSha256"],
                    }
                )
                + "\n"
            )
            process.stdin.close()
            while True:
                event = json.loads(process.stdout.readline())
                if event["type"] == "unloadComplete":
                    sampler.mark_unload_complete()
                if event["type"] == "complete":
                    break
            self.assertEqual(process.wait(timeout=5), 0)
            evidence = sampler.stop()
            self.assertEqual(evidence["baselineRssBytes"], baseline)
            self.assertGreaterEqual(evidence["observedProcessCount"], 2)
            self.assertGreater(
                evidence["absolutePeakRssBytes"],
                evidence["baselineRssBytes"] + 8 * 1024 * 1024,
            )
            self.assertGreaterEqual(evidence["incrementalPeakRssBytes"], 0)
            self.assertIsNotNone(evidence["retainedRssBytesAfterUnload"])
            process.stdout.close()

    def test_root_exit_between_samples_is_diagnostic_not_error(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            start_new_session=True,
        )
        sampler = ProcessTreeSampler(process.pid, interval_seconds=0.01)
        sampler.start()
        process.wait(timeout=5)
        evidence = sampler.stop()
        self.assertGreaterEqual(evidence["missedOrExitedProcessObservations"], 1)
        self.assertGreaterEqual(evidence["absolutePeakRssBytes"], 0)

    def test_worker_self_report_prevents_false_zero_after_tree_detaches(
        self,
    ) -> None:
        process = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            start_new_session=True,
        )
        sampler = ProcessTreeSampler(process.pid, interval_seconds=0.01)
        sampler.start()
        process.wait(timeout=5)
        retained = sampler.mark_unload_complete(
            worker_reported_rss_bytes=64 * 1024 * 1024
        )
        evidence = sampler.stop()
        self.assertEqual(retained, 64 * 1024 * 1024)
        self.assertEqual(
            evidence["retainedRssMeasurementSource"], "worker_self_report"
        )

    def test_explicitly_tracked_worker_survives_root_tree_detachment(self) -> None:
        root = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            start_new_session=True,
        )
        worker = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(2)"],
            start_new_session=True,
        )
        try:
            sampler = ProcessTreeSampler(root.pid, interval_seconds=0.01)
            sampler.start()
            sampler.track_process(worker.pid)
            root.wait(timeout=5)
            retained = sampler.mark_unload_complete()
            evidence = sampler.stop()
            self.assertGreater(retained, 0)
            self.assertEqual(evidence["retainedRssBytesAfterUnload"], retained)
            self.assertIn(worker.pid, sampler._observed_pids)
        finally:
            worker.terminate()
            worker.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
