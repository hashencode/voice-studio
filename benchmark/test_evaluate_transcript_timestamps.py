from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from benchmark.evaluate_transcript_timestamps import evaluate


class EvaluateTranscriptTimestampsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.audio_root = Path(self.temp_dir.name)
        self.audio = self.audio_root / "clip.wav"
        self.audio.write_bytes(b"fixed timestamp fixture")
        self.audio_sha = hashlib.sha256(self.audio.read_bytes()).hexdigest()
        self.reference_segments = [
            {"sequenceId": 0, "startMs": 100, "endMs": 500},
            {"sequenceId": 1, "startMs": 900, "endMs": 1300},
        ]

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def manifest(self, *, review_status: str = "approved") -> dict:
        case = {
            "id": "case",
            "audio": "clip.wav",
            "audioSha256": self.audio_sha,
            "reviewClipSha256": self.audio_sha,
            "reviewStatus": review_status,
            "referenceSegments": self.reference_segments,
        }
        if review_status == "approved":
            case["reviewedBy"] = "independent-reviewer"
            case["reviewedAt"] = "2026-07-25T00:00:00Z"
        return {"schemaVersion": 1, "thresholdP95Ms": 1500, "cases": [case]}

    def predictions(self) -> dict:
        return {
            "schemaVersion": 2,
            "source": "physical_android_production_engine",
            "cases": [
                {
                    "id": "case",
                    "audioSha256": self.audio_sha,
                    "segments": self.reference_segments,
                }
            ],
        }

    def test_approved_physical_predictions_are_release_eligible(self) -> None:
        report = evaluate(
            self.manifest(),
            self.predictions(),
            self.audio_root,
            allow_provisional=False,
        )
        self.assertTrue(report["passed"])
        self.assertTrue(report["releaseEligible"])
        self.assertEqual(report["p95ErrorMs"], 0)

    def test_release_rejects_non_production_predictions(self) -> None:
        predictions = self.predictions()
        predictions["source"] = "copied_reference"
        with self.assertRaisesRegex(ValueError, "physical_android_production_engine"):
            evaluate(
                self.manifest(),
                predictions,
                self.audio_root,
                allow_provisional=False,
            )

    def test_release_rejects_prediction_audio_hash_mismatch(self) -> None:
        predictions = self.predictions()
        predictions["cases"][0]["audioSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "prediction review-clip audioSha256 mismatch"):
            evaluate(
                self.manifest(),
                predictions,
                self.audio_root,
                allow_provisional=False,
            )

    def test_release_rejects_legacy_prediction_schema(self) -> None:
        predictions = self.predictions()
        predictions["schemaVersion"] = 1
        with self.assertRaisesRegex(ValueError, "schemaVersion 2"):
            evaluate(
                self.manifest(),
                predictions,
                self.audio_root,
                allow_provisional=False,
            )

    def test_duplicate_prediction_case_is_rejected(self) -> None:
        predictions = self.predictions()
        predictions["cases"].append(dict(predictions["cases"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate prediction case"):
            evaluate(
                self.manifest(),
                predictions,
                self.audio_root,
                allow_provisional=False,
            )

    def test_extra_prediction_case_is_rejected(self) -> None:
        predictions = self.predictions()
        predictions["cases"].append(
            {
                "id": "unexpected",
                "audioSha256": self.audio_sha,
                "segments": self.reference_segments,
            }
        )
        with self.assertRaisesRegex(ValueError, "exactly match"):
            evaluate(
                self.manifest(),
                predictions,
                self.audio_root,
                allow_provisional=False,
            )

    def test_segment_count_mismatch_remains_a_hard_failure(self) -> None:
        predictions = self.predictions()
        predictions["cases"][0]["segments"] = predictions["cases"][0]["segments"][:1]
        with self.assertRaisesRegex(ValueError, "segment count mismatch"):
            evaluate(
                self.manifest(review_status="provisional"),
                predictions,
                self.audio_root,
                allow_provisional=True,
            )

    def test_provisional_reference_can_only_pass_engineering_gate(self) -> None:
        report = evaluate(
            self.manifest(review_status="provisional"),
            self.predictions(),
            self.audio_root,
            allow_provisional=True,
        )
        self.assertTrue(report["passed"])
        self.assertFalse(report["releaseEligible"])


if __name__ == "__main__":
    unittest.main()
