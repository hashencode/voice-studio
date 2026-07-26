from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from expanded_round import (
    ExpansionError,
    effective_config,
    lexical_metric_for_lane,
    validate_expansion,
)


ROOT = Path(__file__).resolve().parent


class ExpandedRoundTest(unittest.TestCase):
    def setUp(self) -> None:
        self.expansion = json.loads(
            (ROOT / "expanded_candidates_m4.json").read_text()
        )
        self.base = json.loads((ROOT / "candidates.json").read_text())
        self.results = json.loads(
            (ROOT / "expanded_stage0_results_m4.json").read_text()
        )

    def test_committed_expansion_is_valid(self) -> None:
        validate_expansion(self.expansion, self.base)
        self.assertEqual(lexical_metric_for_lane(self.expansion, "zh"), "cer")
        self.assertEqual(lexical_metric_for_lane(self.expansion, "en"), "wer")

    def test_code_switch_cannot_become_required(self) -> None:
        changed = copy.deepcopy(self.expansion)
        changed["languagePolicy"]["codeSwitchRequired"] = True
        with self.assertRaisesRegex(ExpansionError, "independent rankings"):
            validate_expansion(changed, self.base)

    def test_new_model_hashes_are_required_and_role_exact(self) -> None:
        changed = copy.deepcopy(self.expansion)
        changed["newCandidates"][0]["artifacts"].pop("tokens")
        with self.assertRaisesRegex(ExpansionError, "model roles"):
            validate_expansion(changed, self.base)

    def test_fixed_resource_profile_is_common_across_new_families(self) -> None:
        for candidate in self.expansion["newCandidates"]:
            config = effective_config(
                candidate["family"],
                language_lane=candidate["languageLanes"][0],
                profile_id="fixed-resource",
            )
            self.assertEqual(config["provider"], "cpu")
            self.assertEqual(config["numThreads"], 2)
            self.assertEqual(config["concurrency"], 1)
            self.assertEqual(config["segmentDurationSeconds"], 15)
            self.assertEqual(config["warmupRuns"], 1)
            self.assertEqual(config["measuredRuns"], 5)

    def test_funasr_language_is_resolved_per_lane(self) -> None:
        zh = effective_config(
            "funasr_nano",
            language_lane="zh",
            profile_id="recommended",
        )
        en = effective_config(
            "funasr_nano",
            language_lane="en",
            profile_id="recommended",
        )
        self.assertEqual(zh["language"], "zh")
        self.assertEqual(en["language"], "en")

    def test_published_stage0_result_is_bounded_and_not_ranked(self) -> None:
        self.assertFalse(self.results["rankEligible"])
        self.assertEqual(len(self.results["results"]), 10)
        self.assertEqual(
            self.results["summary"],
            {
                "scheduledRunCount": 10,
                "successfulRunCount": 8,
                "failedRunCount": 2,
                "formalDevelopmentRankingComplete": False,
                "heldOutRankingComplete": False,
                "twoHourFinalistComplete": False,
            },
        )
        encoded = json.dumps(self.results).lower()
        for forbidden in (
            "transcript\":",
            "absolute_path",
            "/users/",
            "audio\":",
            "pcm\":",
            "voiceprint",
        ):
            self.assertNotIn(forbidden, encoded)
        for result in self.results["results"]:
            if result["stage0State"] != "PASS":
                continue
            metric = "cer" if result["languageLane"] == "zh" else "wer"
            self.assertIn(metric, result)


if __name__ == "__main__":
    unittest.main()
