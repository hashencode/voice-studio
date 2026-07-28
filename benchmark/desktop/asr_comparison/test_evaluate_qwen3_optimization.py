from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evaluate_qwen3_optimization import (
    DEFAULT_CONTRACT,
    Qwen3OptimizationError,
    bounded_hotwords,
    validate_contract,
    validate_result,
)


class Qwen3OptimizationEvaluatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(DEFAULT_CONTRACT.read_text(encoding="utf-8"))

    def test_contract_pins_target_inputs_and_single_variables(self) -> None:
        validate_contract(self.contract)

    def test_contract_rejects_target_or_fixture_drift(self) -> None:
        target = copy.deepcopy(self.contract)
        target["target"]["cpu"] = "Apple M2"
        with self.assertRaisesRegex(Qwen3OptimizationError, "target"):
            validate_contract(target, validate_files=False)

        fixture = copy.deepcopy(self.contract)
        fixture["inputs"]["fixtureManifestSha256"] = "0" * 64
        with self.assertRaisesRegex(Qwen3OptimizationError, "fixtureManifest hash"):
            validate_contract(fixture)

    def test_arm_cannot_change_two_variables(self) -> None:
        contract = copy.deepcopy(self.contract)
        contract["arms"][1]["threads"] = 3
        with self.assertRaisesRegex(Qwen3OptimizationError, "multiple-variable"):
            validate_contract(contract, validate_files=False)

    def test_hotwords_are_normalized_deduplicated_and_bounded(self) -> None:
        result = bounded_hotwords(
            [" Ｑwen ", "Qwen", "Qwen", "会议"],
            self.contract["hotwordBounds"],
        )
        self.assertEqual(result, ["Qwen", "会议"])
        with self.assertRaisesRegex(Qwen3OptimizationError, "control"):
            bounded_hotwords(
                ["bad\nterm"],
                self.contract["hotwordBounds"],
            )

    def test_blocked_fixed_inputs_keep_control_without_fake_pass(self) -> None:
        result = validate_result(
            {
                "schemaVersion": 2,
                "contractId": self.contract["contractId"],
                "status": "BLOCKED",
                "missingInputs": ["far_field_noisy_meeting"],
            },
            self.contract,
        )
        self.assertEqual(result["status"], "PENDING_FIXED_INPUTS")
        self.assertEqual(result["selectedArm"], "control")

    def test_speed_arm_promotes_only_with_quality_guardrail(self) -> None:
        result = self._complete_result()
        result["arms"].append(
            self._observation(
                "runtime-ort-1.24.4",
                "runtime",
                error_rate=0.101,
                non_target_error=0.101,
                recall=0.6,
                rtf=0.16,
            )
        )
        decision = validate_result(result, self.contract)
        self.assertEqual(decision["status"], "OPTIMIZATION_ADMITTED")
        self.assertEqual(decision["selectedArm"], "runtime-ort-1.24.4")

        result["arms"][1]["nonTargetErrorRate"] = 0.1041
        decision = validate_result(result, self.contract)
        self.assertEqual(decision["status"], "CONTROL_RETAINED")

    def test_token_truncation_never_promotes(self) -> None:
        result = self._complete_result()
        arm = self._observation(
            "tokens-128",
            "maxNewTokens",
            error_rate=0.09,
            non_target_error=0.09,
            recall=0.7,
            rtf=0.15,
        )
        arm["truncated"] = True
        result["arms"].append(arm)
        decision = validate_result(result, self.contract)
        self.assertEqual(decision["status"], "CONTROL_RETAINED")
        self.assertEqual(decision["selectedArm"], "control")

    def test_derived_vad_arm_cannot_bypass_its_base_gate(self) -> None:
        result = self._complete_result()
        result["arms"].extend(
            [
                self._observation(
                    "vad-official-20",
                    "segmentation",
                    error_rate=0.105,
                    non_target_error=0.105,
                    recall=0.6,
                    rtf=0.25,
                ),
                self._observation(
                    "vad-max-speech-12",
                    "maxSpeechSeconds",
                    error_rate=0.08,
                    non_target_error=0.08,
                    recall=0.8,
                    rtf=0.15,
                ),
            ]
        )
        decision = validate_result(result, self.contract)
        self.assertEqual(decision["status"], "CONTROL_RETAINED")

    def test_probe_over_thirty_minutes_is_rejected(self) -> None:
        result = self._complete_result()
        result["arms"][0]["probeDurationSeconds"] = 1800.1
        with self.assertRaisesRegex(Qwen3OptimizationError, "30 minutes"):
            validate_result(result, self.contract)

    def _complete_result(self) -> dict:
        return {
            "schemaVersion": 2,
            "contractId": self.contract["contractId"],
            "status": "COMPLETE",
            "target": self.contract["target"],
            "fixtureManifestSha256": self.contract["inputs"][
                "fixtureManifestSha256"
            ],
            "scoringContractSha256": self.contract["inputs"][
                "scoringContractSha256"
            ],
            "arms": [
                self._observation(
                    "control",
                    None,
                    error_rate=0.101,
                    non_target_error=0.101,
                    recall=0.6,
                    rtf=0.24,
                )
            ],
        }

    def _observation(
        self,
        arm_id: str,
        variable: str | None,
        *,
        error_rate: float,
        non_target_error: float,
        recall: float,
        rtf: float,
    ) -> dict:
        return {
            "id": arm_id,
            "baseArmId": (
                None
                if arm_id == "control"
                else next(
                    arm["baseArmId"]
                    for arm in self.contract["arms"]
                    if arm["id"] == arm_id
                )
            ),
            "changedVariable": variable,
            "modelHashes": self.contract["model"]["hashes"],
            "probeDurationSeconds": 300,
            "warmupRuns": 1,
            "measuredRuns": 3,
            "errorRate": error_rate,
            "nonTargetErrorRate": non_target_error,
            "targetTermRecall": recall,
            "rtf": rtf,
            "peakRssBytes": 1_000_000,
            "retainedRssBytes": 500_000,
            "coldLoadMs": 1000,
            "warmLoadMs": 100,
            "p95SegmentLatencyMs": 400,
            "cancellationClean": True,
            "temporaryFilesClean": True,
            "truncated": False,
            "hallucinated": False,
        }


if __name__ == "__main__":
    unittest.main()
