from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from tool.validate_macos_closure import (
    DEFAULT_EVIDENCE,
    validate_macos_closure,
)


class MacosClosureValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.evidence = json.loads(DEFAULT_EVIDENCE.read_text(encoding="utf-8"))

    def _validate_mutation(self, evidence: dict) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "u9.json"
            path.write_text(
                json.dumps(evidence, ensure_ascii=False),
                encoding="utf-8",
            )
            validate_macos_closure(path, validate_scope=False)

    def test_repository_closure_is_reopened_for_qwen3(self) -> None:
        result = validate_macos_closure()
        self.assertEqual(
            "MACOS_QWEN3_REVALIDATION_REQUIRED",
            result["disposition"],
        )

    def test_missing_required_evidence_fails(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        evidence["evidenceBindings"].pop()
        with self.assertRaisesRegex(ValueError, "missing required"):
            self._validate_mutation(evidence)

    def test_lab_only_engine_cannot_enter_product(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        evidence["productEngine"]["diarization"] = "LAB_ONLY_pyannote"
        with self.assertRaisesRegex(ValueError, "LAB_ONLY"):
            self._validate_mutation(evidence)

    @unittest.skip("historical Zipformer closure is superseded by Qwen3 revalidation")
    def test_unverified_lan_fails(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        evidence["lanHandoff"]["status"] = "UNVERIFIED"
        with self.assertRaisesRegex(ValueError, "LAN handoff"):
            self._validate_mutation(evidence)

    def test_product_artifact_hash_drift_fails(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        first = next(iter(evidence["productEngine"]["artifactHashes"]))
        evidence["productEngine"]["artifactHashes"][first] = "0" * 64
        with self.assertRaisesRegex(ValueError, "artifact hash drift"):
            self._validate_mutation(evidence)

    @unittest.skip("historical Zipformer closure is superseded by Qwen3 revalidation")
    def test_dogfood_quality_regression_fails(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        evidence["experienceGate"]["engineeringDogfood"][
            "aggregateSpeakerCorrectionRate"
        ] = 0.11
        with self.assertRaisesRegex(ValueError, "dogfood"):
            self._validate_mutation(evidence)

    @unittest.skip("historical Zipformer closure is superseded by Qwen3 revalidation")
    def test_two_hour_runtime_regression_fails(self) -> None:
        evidence = copy.deepcopy(self.evidence)
        evidence["experienceGate"]["longMeeting"]["elapsedMilliseconds"] = 1_800_000
        with self.assertRaisesRegex(ValueError, "two-hour"):
            self._validate_mutation(evidence)


if __name__ == "__main__":
    unittest.main()
