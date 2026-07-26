import copy
import unittest

from validate_macos_engine_selection import validate


class MacosEngineSelectionTest(unittest.TestCase):
    def setUp(self):
        self.registry = {
            "decisionId": "decision",
            "machineDecision": {
                "status": "FINALISTS_FROZEN",
                "winners": {"asr": "asr-winner", "diarization": "diar-winner"},
                "selectedRuntime": "runtime",
                "selectedBoundary": "worker",
                "sidecarWinner": None,
            },
            "candidates": [
                {"failedSelectionGates": ["QUALITY_REGRESSION"]},
                {"hardFailures": ["USER_CONDITIONS_NOT_ACCEPTED"]},
            ],
        }
        self.document = " ".join(
            (
                "decision",
                "FINALISTS_FROZEN",
                "asr-winner",
                "diar-winner",
                "runtime",
                "worker",
                "null",
                "QUALITY_REGRESSION",
                "USER_CONDITIONS_NOT_ACCEPTED",
            )
        )

    def test_accepts_agreement(self):
        validate(self.registry, self.document)

    def test_rejects_winner_drift(self):
        registry = copy.deepcopy(self.registry)
        registry["machineDecision"]["winners"]["asr"] = "other"
        with self.assertRaises(ValueError):
            validate(registry, self.document)

    def test_rejects_excluded_engine(self):
        with self.assertRaises(ValueError):
            validate(self.registry, self.document + " whisper")


if __name__ == "__main__":
    unittest.main()
