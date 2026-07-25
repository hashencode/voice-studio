from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from benchmark.validate_asr_model_candidates import (
    DEFAULT_REGISTRY,
    RegistryValidationError,
    validate_registry,
)


class ValidateAsrModelCandidatesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(DEFAULT_REGISTRY.read_text(encoding="utf-8"))

    def validate(self, payload: dict) -> None:
        validate_registry(
            payload,
            root=Path(__file__).resolve().parents[1],
            verify_local_artifacts=False,
        )

    def candidate(self, payload: dict, candidate_id: str) -> dict:
        return next(
            candidate
            for candidate in payload["candidates"]
            if candidate["id"] == candidate_id
        )

    def mark_production_eligible(self, candidate: dict) -> None:
        candidate["capabilities"] = {
            capability: "verified" for capability in candidate["capabilities"]
        }
        report = {"status": "pass", "reportSha256": "a" * 64}
        candidate["admission"] = {
            "state": "production_eligible",
            "reasons": [],
            "gates": {
                gate: copy.deepcopy(report)
                for gate in (
                    "accuracy",
                    "timestamps",
                    "hotwords",
                    "confidenceCalibration",
                    "itn",
                    "rtf",
                    "peakMemory",
                    "thermalBattery",
                    "packageSize",
                )
            },
            "deviceEvidence": {
                "low": copy.deepcopy(report),
                "mid": copy.deepcopy(report),
            },
        }

    def test_repository_registry_is_valid(self) -> None:
        validate_registry(self.payload)

    def test_unknown_model_license_cannot_be_production_eligible(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-int8-2025-06-30")
        candidate["admission"] = {"state": "production_eligible", "reasons": []}
        candidate["artifact"]["sha256"] = "a" * 64
        candidate["capabilities"]["timestamps"] = "verified"
        candidate["capabilities"]["scoreSignal"] = "verified"
        candidate["capabilities"]["decoderHotwords"] = "verified"

        with self.assertRaisesRegex(
            RegistryValidationError,
            "production eligibility requires a clear model license",
        ):
            self.validate(payload)

    def test_runtime_license_does_not_substitute_for_model_license(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-int8-2025-06-30")
        candidate["modelLicense"] = {
            "status": "clear",
            "spdx": "Apache-2.0",
            "evidence": None,
        }

        with self.assertRaisesRegex(
            RegistryValidationError,
            "clear license requires evidence",
        ):
            self.validate(payload)

    def test_paraformer_cannot_claim_confidence_or_decoder_hotwords(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "paraformer-zh-2025-10-07")
        candidate["capabilities"]["scoreSignal"] = "available_unverified"

        with self.assertRaisesRegex(
            RegistryValidationError,
            "current Paraformer cannot claim a score signal",
        ):
            self.validate(payload)

    def test_unpinned_archive_cannot_be_production_eligible(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "vosk-model-small-cn-0.22")
        candidate["modelLicense"]["status"] = "clear"
        candidate["admission"] = {"state": "production_eligible", "reasons": []}
        candidate["capabilities"]["timestamps"] = "verified"
        candidate["capabilities"]["scoreSignal"] = "verified"
        candidate["capabilities"]["decoderHotwords"] = "verified"

        with self.assertRaisesRegex(
            RegistryValidationError,
            "production eligibility requires a pinned artifact sha256",
        ):
            self.validate(payload)

    def test_capability_gap_cannot_be_production_eligible(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-14m-2023-02-23")
        candidate["admission"] = {"state": "production_eligible", "reasons": []}

        with self.assertRaisesRegex(
            RegistryValidationError,
            "requires verified timestamps",
        ):
            self.validate(payload)

    def test_missing_benchmark_gates_cannot_be_production_eligible(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-14m-2023-02-23")
        candidate["capabilities"] = {
            capability: "verified" for capability in candidate["capabilities"]
        }
        candidate["admission"] = {"state": "production_eligible", "reasons": []}

        with self.assertRaisesRegex(
            RegistryValidationError,
            "requires every benchmark gate",
        ):
            self.validate(payload)

    def test_downloadable_production_artifact_requires_per_file_hashes(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-14m-2023-02-23")
        self.mark_production_eligible(candidate)
        candidate["artifact"].pop("requiredFileSha256")

        with self.assertRaisesRegex(
            RegistryValidationError,
            "every required file needs a pinned sha256",
        ):
            self.validate(payload)

    def test_missing_device_classes_cannot_be_production_eligible(self) -> None:
        payload = copy.deepcopy(self.payload)
        candidate = self.candidate(payload, "streaming-zipformer-zh-14m-2023-02-23")
        candidate["capabilities"] = {
            capability: "verified" for capability in candidate["capabilities"]
        }
        report = {"status": "pass", "reportSha256": "a" * 64}
        candidate["admission"] = {
            "state": "production_eligible",
            "reasons": [],
            "gates": {
                gate: copy.deepcopy(report)
                for gate in (
                    "accuracy",
                    "timestamps",
                    "hotwords",
                    "confidenceCalibration",
                    "itn",
                    "rtf",
                    "peakMemory",
                    "thermalBattery",
                    "packageSize",
                )
            },
            "deviceEvidence": {"mid": copy.deepcopy(report)},
        }

        with self.assertRaisesRegex(
            RegistryValidationError,
            "requires low and mid device evidence",
        ):
            self.validate(payload)


if __name__ == "__main__":
    unittest.main()
