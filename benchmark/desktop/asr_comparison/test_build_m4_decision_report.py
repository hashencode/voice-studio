from __future__ import annotations

import unittest

from build_m4_decision_report import _compact_aggregate, _streaming


class M4DecisionReportTest(unittest.TestCase):
    def test_streaming_uses_null_for_unsupported_metrics(self) -> None:
        summary = {
            "candidateIds": ["offline"],
            "languageLane": "en",
            "observations": [
                {
                    "warmup": False,
                    "streamingObservation": {
                        "applicability": "not_applicable",
                        "pacingPolicy": "unpaced",
                        "firstPartialWallMilliseconds": None,
                        "firstPartialStatus": "unsupported",
                        "firstFinalWallMilliseconds": None,
                        "firstFinalStatus": "unsupported",
                        "tailLatencyMilliseconds": None,
                        "tailLatencyStatus": "unsupported",
                        "partialCount": 0,
                    },
                }
            ],
        }
        result = _streaming(summary)
        self.assertEqual(result["applicability"], "not_applicable")
        self.assertIsNone(result["firstPartialWallMilliseconds"]["median"])
        self.assertEqual(
            result["firstPartialWallMilliseconds"]["status"], "unsupported"
        )

    def test_compact_aggregate_selects_lane_metric(self) -> None:
        statistic = {"count": 1, "median": 1.0, "p95": 1.0}
        resource = {**statistic, "maximum": 1}
        aggregate = {
            "candidateId": "candidate",
            "measuredRunCount": 1,
            "macroMetrics": {"cer": 0.1, "wer": 0.2},
            "performance": {
                "loadMilliseconds": statistic,
                "decodeMilliseconds": statistic,
                "endToEndWallMilliseconds": statistic,
                "rtf": statistic,
                "segmentLatencyP50Milliseconds": statistic,
                "segmentLatencyP95Milliseconds": statistic,
            },
            "resources": {
                "absolutePeakRssBytes": resource,
                "incrementalPeakRssBytes": resource,
                "retainedRssBytesAfterUnload": resource,
            },
        }
        result = _compact_aggregate(aggregate, "en")
        self.assertEqual(result["lexicalMetric"], "wer")
        self.assertEqual(result["lexicalErrorRate"], 0.2)


if __name__ == "__main__":
    unittest.main()
