from __future__ import annotations

import copy
import unittest

from aggregate_results import AggregationError, aggregate_candidate, compare_to_baseline


def run(
    scenario: str,
    cer: float,
    *,
    index: int,
    wer: float | None = None,
    warmup: bool = False,
    rtf: float = 0.2,
    rss: int = 100,
    transcript_hash: str = "a",
) -> dict:
    return {
        "runId": f"{scenario}-{index}",
        "candidateId": "candidate",
        "laneId": "lane",
        "profileId": "fixed-resource",
        "scorecard": "core_asr",
        "scenario": scenario,
        "fixtureId": f"fixture-{scenario}",
        "runIndex": index,
        "warmup": warmup,
        "scheduleOrder": index,
        "metrics": {
            "cer": cer,
            "wer": wer,
            "rtf": rtf,
            "loadMilliseconds": 10.0 + index,
            "decodeMilliseconds": 20.0 + index,
            "endToEndWallMilliseconds": 30.0 + index,
            "segmentLatencyP50Milliseconds": 4.0 + index,
            "segmentLatencyP95Milliseconds": 6.0 + index,
            "absolutePeakRssBytes": rss + 200,
            "incrementalPeakRssBytes": rss,
            "retainedRssBytesAfterUnload": rss + 50,
            "terminologyRecall": 0.5,
            "numericEventAccuracy": 0.5,
        },
        "rawOutputSha256": transcript_hash * 64,
    }


class AggregateResultsTest(unittest.TestCase):
    def test_macro_is_equal_weighted_across_scenarios(self) -> None:
        runs = [
            run("long_easy", 0.0, index=index)
            for index in range(1, 101)
        ] + [run("short_hard", 1.0, index=101)]
        aggregate = aggregate_candidate(runs)
        self.assertEqual(aggregate["macroMetrics"]["cer"], 0.5)

    def test_warmup_is_excluded_and_measured_runs_are_preserved(self) -> None:
        runs = [run("clean", 1.0, index=0, warmup=True)] + [
            run("clean", value, index=index)
            for index, value in enumerate([0.1, 0.2, 0.3, 0.4, 0.5], start=1)
        ]
        aggregate = aggregate_candidate(runs)
        self.assertEqual(len(aggregate["runs"]), 6)
        self.assertEqual(aggregate["measuredRunCount"], 5)
        self.assertEqual(aggregate["performance"]["rtf"]["median"], 0.2)
        self.assertEqual(
            aggregate["performance"]["loadMilliseconds"]["median"], 13.0
        )
        self.assertEqual(
            aggregate["performance"]["decodeMilliseconds"]["p95"], 25.0
        )
        self.assertEqual(
            aggregate["performance"]["endToEndWallMilliseconds"]["median"],
            33.0,
        )
        self.assertEqual(
            aggregate["performance"]["segmentLatencyP50Milliseconds"]["median"],
            7.0,
        )
        self.assertEqual(
            aggregate["performance"]["segmentLatencyP95Milliseconds"]["p95"],
            11.0,
        )
        self.assertIn("dispersion", aggregate["performance"]["rtf"])

    def test_english_lane_aggregates_and_gates_on_wer(self) -> None:
        baseline = aggregate_candidate(
            [
                run(
                    "clean_near_field_english",
                    0.08,
                    wer=0.2,
                    index=1,
                )
            ]
        )
        candidate = aggregate_candidate(
            [
                run(
                    "clean_near_field_english",
                    0.4,
                    wer=0.1,
                    index=1,
                )
            ]
        )

        decision = compare_to_baseline(
            candidate,
            baseline,
            lexical_metric="wer",
            hard_gates={
                "maxCer": 0.35,
                "maxWer": 0.35,
                "maxRtf": 0.5,
                "maxFinalistIncrementalPeakRssBytes": 2 * 1024**3,
            },
            materiality={
                "minimumRelativeMacroLexicalErrorReduction": 0.15,
                "minimumHardScenariosImproved": 2,
                "alternativeMinimumTerminologyNumericPointGain": 0.1,
                "maximumRelativeCleanMandarinRegression": 0.05,
            },
        )

        self.assertEqual(candidate["macroMetrics"]["wer"], 0.1)
        self.assertEqual(decision["hardGateResults"]["wer"], "PASS")
        self.assertNotIn("cer", decision["hardGateResults"])
        self.assertEqual(
            decision["materialBenefit"]["lexicalMetric"],
            "wer",
        )

    def test_cross_lane_runs_cannot_be_pooled(self) -> None:
        runs = [run("clean", 0.1, index=1), run("hard", 0.2, index=2)]
        runs[1]["laneId"] = "other-lane"
        with self.assertRaisesRegex(AggregationError, "lane"):
            aggregate_candidate(runs)

    def test_memory_hard_gate_blocks_pareto_before_material_gain(self) -> None:
        baseline_runs = [run("hard-a", 0.4, index=1), run("hard-b", 0.4, index=2)]
        candidate_runs = copy.deepcopy(baseline_runs)
        for item in candidate_runs:
            item["metrics"]["cer"] = 0.2
            item["metrics"]["terminologyRecall"] = 0.7
            item["metrics"]["incrementalPeakRssBytes"] = 3 * 1024**3
        baseline = aggregate_candidate(baseline_runs)
        candidate = aggregate_candidate(candidate_runs)
        decision = compare_to_baseline(
            candidate,
            baseline,
            hard_gates={
                "maxCer": 0.35,
                "maxRtf": 0.5,
                "maxFinalistIncrementalPeakRssBytes": 2 * 1024**3,
            },
            materiality={
                "minimumRelativeMacroLexicalErrorReduction": 0.15,
                "minimumHardScenariosImproved": 2,
                "alternativeMinimumTerminologyNumericPointGain": 0.1,
                "maximumRelativeCleanMandarinRegression": 0.05,
            },
        )
        self.assertEqual(decision["disposition"], "REJECTED_HARD_GATE")
        self.assertFalse(decision["paretoEligible"])

    def test_no_material_benefit_retains_baseline(self) -> None:
        baseline = aggregate_candidate(
            [run("clean_near_field_mandarin", 0.1, index=1)]
        )
        candidate_runs = [run("clean_near_field_mandarin", 0.095, index=1)]
        candidate = aggregate_candidate(candidate_runs)
        decision = compare_to_baseline(
            candidate,
            baseline,
            hard_gates={
                "maxCer": 0.35,
                "maxRtf": 0.5,
                "maxFinalistIncrementalPeakRssBytes": 2 * 1024**3,
            },
            materiality={
                "minimumRelativeMacroLexicalErrorReduction": 0.15,
                "minimumHardScenariosImproved": 2,
                "alternativeMinimumTerminologyNumericPointGain": 0.1,
                "maximumRelativeCleanMandarinRegression": 0.05,
            },
        )
        self.assertEqual(
            decision["disposition"], "RETAIN_BASELINE_NO_MATERIAL_BENEFIT"
        )

    def test_transcript_variance_remains_visible(self) -> None:
        runs = [
            run("non_speech", 0.0, index=1, transcript_hash="a"),
            run("non_speech", 0.0, index=2, transcript_hash="b"),
        ]
        aggregate = aggregate_candidate(runs)
        self.assertEqual(aggregate["determinism"]["distinctRawOutputCount"], 2)
        self.assertFalse(aggregate["determinism"]["stable"])


if __name__ == "__main__":
    unittest.main()
