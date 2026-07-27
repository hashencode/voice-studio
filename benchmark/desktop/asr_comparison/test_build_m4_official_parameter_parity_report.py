from __future__ import annotations

import unittest

from build_m4_official_parameter_parity_report import _profile_comparisons


class OfficialParameterParityReportTest(unittest.TestCase):
    def test_profile_comparison_detects_unchanged_output_and_error_rate(self) -> None:
        base = {
            "languageLane": "en",
            "candidateId": "candidate",
            "lexicalErrorRate": 0.1,
            "rawOutputSha256": "same",
        }
        result = _profile_comparisons(
            [
                {**base, "profileId": "official_recommended"},
                {**base, "profileId": "fixed_resource"},
            ]
        )
        self.assertFalse(result[0]["errorRateChanged"])
        self.assertFalse(result[0]["rawOutputChanged"])

    def test_profile_comparison_rejects_missing_profile(self) -> None:
        with self.assertRaises(ValueError):
            _profile_comparisons(
                [
                    {
                        "languageLane": "zh",
                        "candidateId": "candidate",
                        "lexicalErrorRate": 0.0,
                        "rawOutputSha256": "hash",
                    }
                ]
            )


if __name__ == "__main__":
    unittest.main()
