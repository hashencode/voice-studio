from __future__ import annotations

import unittest

from pathlib import Path

from run_qwen3_m4_experiment import _formal_revision, effective_config


class Qwen3M4ExperimentTest(unittest.TestCase):
    def test_official_profile_uses_documented_generation_controls(self) -> None:
        profile = effective_config("official-recommended")
        self.assertEqual(profile["maxTotalLen"], 512)
        self.assertEqual(profile["maxNewTokens"], 512)
        self.assertEqual(profile["temperature"], 0.000001)
        self.assertEqual(profile["topP"], 0.8)
        self.assertEqual(profile["seed"], 42)
        self.assertNotIn("segmentDurationSeconds", profile)

    def test_fixed_profile_changes_segmentation_not_generation(self) -> None:
        official = effective_config("official-recommended")
        fixed = effective_config("fixed-resource")
        for key, value in official.items():
            self.assertEqual(fixed[key], value)
        self.assertEqual(fixed["segmentDurationSeconds"], 15)
        self.assertEqual(fixed["numThreads"], 2)
        self.assertEqual(fixed["concurrency"], 1)

    def test_unknown_profile_fails(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            effective_config("invented")

    def test_formal_revision_removes_only_memory_hard_gate(self) -> None:
        _, revision = _formal_revision(Path(__file__).resolve().parent)
        policy = revision["selectionPolicy"]
        self.assertFalse(policy["memory"]["hardGate"])
        self.assertEqual(policy["memory"]["disposition"], "advisory_only")
        self.assertEqual(policy["hardGates"]["maximumCer"], 0.35)
        self.assertEqual(policy["hardGates"]["maximumWer"], 0.35)
        self.assertEqual(policy["hardGates"]["maximumRtf"], 0.5)


if __name__ == "__main__":
    unittest.main()
