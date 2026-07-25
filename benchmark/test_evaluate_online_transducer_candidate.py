from __future__ import annotations

import unittest

from benchmark.evaluate_online_transducer_candidate import (
    alignment,
    expected_calibration_error,
    index_runs,
    roc_auc,
    validate_evidence_identity,
)


class EvaluateOnlineTransducerCandidateTest(unittest.TestCase):
    def test_alignment_labels_substitutions_and_insertions(self) -> None:
        distance, labels = alignment("abcd", "abxcd")
        self.assertEqual(distance, 1)
        self.assertEqual(labels, [True, True, False, True, True])

    def test_alignment_labels_deletions_without_inventing_output_error(self) -> None:
        distance, labels = alignment("abcd", "acd")
        self.assertEqual(distance, 1)
        self.assertEqual(labels, [True, True, True])

    def test_ece_is_zero_for_perfectly_calibrated_extremes(self) -> None:
        self.assertEqual(expected_calibration_error([1.0, 0.0], [True, False]), 0.0)

    def test_auc_orders_correct_above_incorrect(self) -> None:
        self.assertEqual(roc_auc([0.9, 0.8, 0.2], [True, True, False]), 1.0)

    def test_auc_is_none_without_both_classes(self) -> None:
        self.assertIsNone(roc_auc([0.9], [True]))

    def test_physical_model_hashes_are_bound_to_registry(self) -> None:
        hashes = {
            "encoder": "a" * 64,
            "decoder": "b" * 64,
            "joiner": "c" * 64,
            "tokens": "d" * 64,
        }
        manifest = {
            "candidateId": "candidate",
            "decoder": {
                "method": "modified_beam_search",
                "maxActivePaths": 4,
                "hotwordsScore": 1.5,
            },
        }
        registry = {
            "candidates": [
                {
                    "id": "candidate",
                    "artifact": {"requiredFileSha256": hashes},
                }
            ]
        }
        evidence = {
            "decoderMethod": "modified_beam_search",
            "maxActivePaths": 4,
            "hotwordsScore": 1.5,
            "modelFiles": {
                f"{key}Sha256": value for key, value in hashes.items()
            },
        }
        validate_evidence_identity(manifest, registry, evidence)
        evidence["modelFiles"]["encoderSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "encoder hash mismatch"):
            validate_evidence_identity(manifest, registry, evidence)

    def test_duplicate_run_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate physical evidence run id"):
            index_runs(
                {
                    "runs": [
                        {"id": "baseline"},
                        {"id": "baseline"},
                        {"id": "hotword_score_1_5"},
                    ]
                }
            )

    def test_extra_run_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "run ids must be exactly"):
            index_runs(
                {
                    "runs": [
                        {"id": "baseline"},
                        {"id": "hotword_score_1_5"},
                        {"id": "cherry_picked"},
                    ]
                }
            )


if __name__ == "__main__":
    unittest.main()
