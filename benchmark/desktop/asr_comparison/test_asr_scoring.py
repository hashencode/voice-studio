from __future__ import annotations

import math
import unittest

from asr_scoring import ScoringError, edit_statistics, normalize_lexical, score_text


class AsrScoringTest(unittest.TestCase):
    def test_mixed_chinese_english_case_spacing_and_punctuation(self) -> None:
        score = score_text(
            "请运行 Smoke Test，马上。",
            "请运行 smoke   test 马上",
            duration_seconds=2.0,
        )
        self.assertEqual(normalize_lexical("ＡＢＣ， Test"), "abc test")
        self.assertEqual(score["lexical"]["cer"], 0.0)
        self.assertEqual(score["lexical"]["wer"], 0.0)
        self.assertLess(score["display"]["punctuationRecall"], 1.0)

    def test_edit_statistics_preserve_operation_counts(self) -> None:
        score = edit_statistics(list("abcd"), list("axcde"))
        self.assertEqual(score["substitutions"], 1)
        self.assertEqual(score["insertions"], 1)
        self.assertEqual(score["deletions"], 0)
        self.assertEqual(score["distance"], 2)

    def test_itn_does_not_hide_lexical_number_error(self) -> None:
        score = score_text(
            "预算是一百二十元。",
            "预算是120元。",
            duration_seconds=1.0,
            annotations={
                "numericEvents": [
                    {
                        "expectedLexicalAlternatives": ["一百二十"],
                        "expectedDisplay": "120",
                    }
                ]
            },
        )
        self.assertGreater(score["lexical"]["cer"], 0.0)
        self.assertEqual(score["lexical"]["numericEventAccuracy"], 0.0)
        self.assertEqual(score["display"]["itnEventAccuracy"], 1.0)

    def test_terminology_and_code_switch_views_are_separate(self) -> None:
        score = score_text(
            "请部署 release candidate 到测试环境",
            "请部署 Release Candidate 到测试环境",
            duration_seconds=1.0,
            annotations={
                "terminology": [{"expectedAlternatives": ["release candidate"]}],
                "codeSwitch": True,
            },
        )
        self.assertEqual(score["lexical"]["terminologyRecall"], 1.0)
        self.assertEqual(score["lexical"]["codeSwitchZhCer"], 0.0)
        self.assertEqual(score["lexical"]["codeSwitchEnWer"], 0.0)

    def test_empty_reference_and_hypothesis_are_exact_without_nan(self) -> None:
        score = score_text("", "", duration_seconds=1.0)
        self.assertTrue(score["lexical"]["exactUtterance"])
        self.assertIsNone(score["lexical"]["cer"])
        self.assertFalse(
            any(
                isinstance(value, float) and not math.isfinite(value)
                for section in score.values()
                if isinstance(section, dict)
                for value in section.values()
            )
        )

    def test_non_speech_hallucination_is_per_minute(self) -> None:
        score = score_text("", "幻觉", duration_seconds=30.0)
        self.assertEqual(
            score["nonSpeech"]["hallucinationLexicalCharactersPerMinute"],
            4.0,
        )

    def test_zero_duration_non_speech_is_rejected(self) -> None:
        with self.assertRaisesRegex(ScoringError, "duration"):
            score_text("", "幻觉", duration_seconds=0.0)


if __name__ == "__main__":
    unittest.main()
