import copy
import unittest

from validate_desktop_candidates import validate


def evidence() -> dict:
    return {"path": "evidence.json", "sha256": "a" * 64}


class DesktopCandidatesTest(unittest.TestCase):
    def setUp(self):
        self.contract = {"decisionPlatform": "macos"}
        self.registry = {
            "schemaVersion": 2,
            "decisionPlatform": "macos",
            "benchmarkContract": "benchmark/desktop/desktop_benchmark_contract.json",
            "targetFingerprint": {
                "operatingSystemVersion": "15.7.5",
                "architecture": "arm64",
                "cpuModel": "Apple M2",
                "logicalCpuCount": 8,
                "memoryBytes": 16,
            },
            "candidates": [
                {
                    "id": "sherpa-streaming-zipformer-zh-14m-2023-02-23",
                    "capability": "asr.zh",
                    "licenseDisposition": "PRODUCT_ELIGIBLE_APACHE_2_0",
                    "status": "SELECTED",
                    "evidence": evidence(),
                },
                {
                    "id": "funasr-paraformer-vad-punctuation",
                    "capability": "asr.zh",
                    "licenseDisposition": "PRODUCT_REVIEW_ELIGIBLE_APACHE_2_0",
                    "status": "NOT_SELECTED_COST_EXCEEDS_BENEFIT",
                    "absoluteGates": {
                        gate: "PASS"
                        for gate in (
                            "paraformer",
                            "vad",
                            "punctuation",
                            "itnRequested",
                            "timestamps",
                            "cer",
                            "rtf",
                        )
                    },
                    "metrics": {
                        "cer": 0.1,
                        "rtf": 0.2,
                        "coldStartupSeconds": 4.0,
                        "incrementalPeakRssBytes": 3,
                    },
                    "relativeToSherpa": {
                        "qualityBenefit": False,
                        "costBenefit": False,
                    },
                    "failedSelectionGates": ["quality", "rtf", "memory"],
                    "evidence": evidence(),
                },
                {
                    "id": "sherpa-pyannote-3.0-3dspeaker",
                    "capability": "diarization",
                    "licenseDisposition": "PRODUCT_ELIGIBLE_WITH_PINNED_NOTICES",
                    "status": "SELECTED",
                    "evidence": [evidence()],
                },
                {
                    "id": "pyannote-community-1",
                    "capability": "diarization",
                    "modelRevision": "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee",
                    "licenseDisposition": "LAB_ONLY_USER_CONDITIONS_NOT_ACCEPTED",
                    "status": "LAB_ONLY",
                    "hardFailures": ["USER_CONDITIONS_NOT_ACCEPTED"],
                    "metrics": None,
                    "evidence": evidence(),
                },
            ],
            "machineDecision": {
                "status": "FINALISTS_FROZEN",
                "hardFailuresAppliedBeforeBenefits": True,
                "winners": {
                    "asr": "sherpa-streaming-zipformer-zh-14m-2023-02-23",
                    "diarization": "sherpa-pyannote-3.0-3dspeaker",
                },
                "selectedRuntime": "sherpa-onnx-c-api@1.13.4",
                "sidecarWinner": None,
                "productSidecarDeliveryRequired": False,
                "noticesRequired": ["runtime", "segmentation", "embedding"],
            },
        }

    def test_accepts_complete_frozen_matrix(self):
        validate(self.contract, self.registry)

    def test_rejects_whisper_or_matrix_drift(self):
        registry = copy.deepcopy(self.registry)
        registry["candidates"][1]["id"] = "whisper"
        with self.assertRaises(ValueError):
            validate(self.contract, registry)

    def test_rejects_lab_only_selection(self):
        registry = copy.deepcopy(self.registry)
        registry["candidates"][3]["status"] = "SELECTED"
        with self.assertRaises(ValueError):
            validate(self.contract, registry)

    def test_rejects_missing_funasr_component(self):
        registry = copy.deepcopy(self.registry)
        del registry["candidates"][1]["absoluteGates"]["vad"]
        with self.assertRaises(ValueError):
            validate(self.contract, registry)

    def test_rejects_unaccepted_pyannote_without_hard_failure(self):
        registry = copy.deepcopy(self.registry)
        registry["candidates"][3]["hardFailures"] = ["other"]
        with self.assertRaises(ValueError):
            validate(self.contract, registry)

    def test_rejects_document_machine_winner_drift(self):
        registry = copy.deepcopy(self.registry)
        registry["machineDecision"]["winners"]["asr"] = (
            "funasr-paraformer-vad-punctuation"
        )
        with self.assertRaises(ValueError):
            validate(self.contract, registry)


if __name__ == "__main__":
    unittest.main()
