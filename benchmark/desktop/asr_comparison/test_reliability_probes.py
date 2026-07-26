from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from reliability_probes import run_reliability_probes


ROOT = Path(__file__).resolve().parents[3]


class ReliabilityProbesTest(unittest.TestCase):
    def test_fake_and_sandboxed_smoke_reliability_matrix(self) -> None:
        result = run_reliability_probes(ROOT)
        outcomes = {
            probe["probeId"]: probe
            for probe in result["probes"]
        }
        self.assertEqual(
            set(outcomes),
            {
                "crash",
                "timeout",
                "oom",
                "empty_output",
                "malformed_output",
                "malformed_input",
                "short_input",
                "silent_input",
                "deterministic_repeat",
                "term_resistant_cancellation",
                "temporary_cleanup",
                "sandbox_denial",
                "atomic_publication",
            },
        )
        self.assertTrue(all(probe["outcome"] == "PASS" for probe in outcomes.values()))
        self.assertEqual(outcomes["oom"]["disposition"], "OOM")
        self.assertEqual(
            outcomes["malformed_input"]["disposition"], "INVALID_INPUT"
        )
        cancellation = outcomes["term_resistant_cancellation"]["details"]
        self.assertTrue(cancellation["processGroupGone"])
        self.assertTrue(cancellation["descendantProcessesGone"])
        self.assertTrue(cancellation["temporaryArtifactsReleased"])
        sandbox = outcomes["sandbox_denial"]["details"]
        self.assertTrue(sandbox["networkPermissionDenied"])
        self.assertTrue(sandbox["userHomePermissionDenied"])
        self.assertTrue(result["determinism"]["stable"])
        self.assertEqual(result["determinism"]["distinctRawOutputCount"], 1)
        self.assertEqual(
            result["hallucination"]["lexicalCharactersPerMinute"], 0
        )
        self.assertEqual(result["emptyOutputCer"], 1)


if __name__ == "__main__":
    unittest.main()
