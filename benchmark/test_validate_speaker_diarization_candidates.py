import copy
import json
import unittest
from pathlib import Path

from benchmark.validate_speaker_diarization_candidates import (
    CandidateMatrixError,
    validate_candidates,
)


class SpeakerDiarizationCandidatesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.matrix = json.loads(
            Path("benchmark/speaker_diarization_candidates.json").read_text(
                encoding="utf-8"
            )
        )
        cls.contract = json.loads(
            Path("benchmark/speaker_diarization_admission_contract.json").read_text(
                encoding="utf-8"
            )
        )

    def test_repository_closes_after_exactly_one_screened_fallback(self):
        result = validate_candidates(
            copy.deepcopy(self.matrix),
            copy.deepcopy(self.contract),
        )

        self.assertEqual(
            "sherpa-v1.13.3-pyannote-int8-3dspeaker",
            result["selectedFallbackId"],
        )
        self.assertEqual(0, result["activeFallbackCount"])
        self.assertEqual("DEFERRED_NO_ADMISSIBLE_CANDIDATE", result["decision"])

    def test_rejects_second_active_fallback(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["candidates"][1]["selectionStatus"] = "ACTIVE_FALLBACK"
        matrix["candidates"][1]["rejectionReason"] = None

        with self.assertRaisesRegex(CandidateMatrixError, "cannot retain an active"):
            validate_candidates(matrix, self.contract)

    def test_rejects_embedding_only_candidate(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["candidates"][0]["fullPipeline"] = False

        with self.assertRaisesRegex(CandidateMatrixError, "not a full pipeline"):
            validate_candidates(matrix, self.contract)

    def test_rejects_missing_android_binding(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["candidates"][0]["androidBinding"] = None

        with self.assertRaisesRegex(CandidateMatrixError, "no Android binding"):
            validate_candidates(matrix, self.contract)

    def test_rejects_unknown_model_license(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["candidates"][0]["modelLicensesComplete"] = False

        with self.assertRaisesRegex(CandidateMatrixError, "license is incomplete"):
            validate_candidates(matrix, self.contract)

    def test_rejects_missing_artifact_hash(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["candidates"][0]["segmentationSha256"] = None

        with self.assertRaisesRegex(CandidateMatrixError, "segmentationSha256 missing"):
            validate_candidates(matrix, self.contract)

    def test_rejects_threshold_drift(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["fixedAdmissionInputs"]["maximumDer"] = 0.31

        with self.assertRaisesRegex(CandidateMatrixError, "frozen fixture or threshold"):
            validate_candidates(matrix, self.contract)

    def test_rejects_activation_before_current_hard_failure(self):
        matrix = copy.deepcopy(self.matrix)
        matrix["currentCandidate"]["decision"] = "ADVANCE_TO_FINAL_GATE"

        with self.assertRaisesRegex(
            CandidateMatrixError,
            "before current candidate rejection",
        ):
            validate_candidates(matrix, self.contract)


if __name__ == "__main__":
    unittest.main()
