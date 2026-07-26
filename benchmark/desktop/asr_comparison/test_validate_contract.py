from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from validate_contract import ContractError, validate_bundle, validate_round_state


ROOT = Path(__file__).resolve().parent


class ContractBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads((ROOT / "macos_contract.json").read_text())
        self.candidates = json.loads((ROOT / "candidates.json").read_text())
        self.scoring = json.loads((ROOT / "scoring_contract.json").read_text())

    def validate(self) -> None:
        validate_bundle(self.contract, self.candidates, self.scoring)

    def test_accepts_frozen_first_round_bundle(self) -> None:
        self.validate()

    def test_requires_exact_first_round_candidate_set(self) -> None:
        self.candidates["candidates"].pop()
        with self.assertRaisesRegex(ContractError, "first-round candidate set"):
            self.validate()

    def test_rejects_ambiguous_candidate_identity(self) -> None:
        self.candidates["candidates"][0]["candidateId"] = "paraformer"
        with self.assertRaisesRegex(ContractError, "first-round candidate set"):
            self.validate()

    def test_android_evidence_is_screening_only(self) -> None:
        self.contract["runtimeLanes"][0]["target"]["operatingSystem"] = "android"
        with self.assertRaisesRegex(ContractError, "macos"):
            self.validate()

    def test_rankable_upgraded_lane_requires_same_lane_baseline(self) -> None:
        lane = copy.deepcopy(self.contract["runtimeLanes"][0])
        lane["laneId"] = "sherpa-onnx-dart-2.0.0-macos-arm64"
        lane["runtime"]["version"] = "2.0.0"
        lane["members"] = [
            "sherpa-onnx-funasr-nano-int8-2025-12-30",
        ]
        lane["rankable"] = True
        self.contract["runtimeLanes"].append(lane)
        with self.assertRaisesRegex(ContractError, "same-lane baseline"):
            self.validate()

    def test_native_control_cannot_enter_sherpa_ranking_lane(self) -> None:
        self.contract["runtimeLanes"][0]["members"].append(
            "native-funasr-1.3.22-paraformer-vad-punctuation"
        )
        with self.assertRaisesRegex(ContractError, "cross-runtime control"):
            self.validate()

    def test_recommended_profiles_may_be_family_specific(self) -> None:
        paraformer = self._candidate(
            "sherpa-onnx-paraformer-zh-int8-2025-10-07"
        )
        nano = self._candidate(
            "sherpa-onnx-funasr-nano-int8-2025-12-30"
        )
        self.assertNotEqual(
            paraformer["profiles"]["recommended"]["effectiveConfig"],
            nano["profiles"]["recommended"]["effectiveConfig"],
        )
        self.validate()

    def test_fixed_resource_invariants_cannot_drift(self) -> None:
        candidate = self._candidate(
            "sherpa-onnx-paraformer-zh-int8-2025-10-07"
        )
        candidate["profiles"]["fixed-resource"]["effectiveConfig"][
            "numThreads"
        ] = 4
        with self.assertRaisesRegex(ContractError, "fixed-resource"):
            self.validate()

    def test_admitted_candidate_requires_pinned_artifact_hashes(self) -> None:
        candidate = self._candidate(
            "sherpa-onnx-funasr-nano-int8-2025-12-30"
        )
        candidate["admission"]["status"] = "ADMITTED"
        with self.assertRaisesRegex(ContractError, "hash-pinned"):
            self.validate()

    def test_unknown_rank_affecting_key_is_rejected(self) -> None:
        self.contract["hardGates"]["hiddenWeight"] = 0.4
        with self.assertRaisesRegex(ContractError, "hardGates fields"):
            self.validate()

    def test_profile_frozen_after_held_out_inspection_is_invalid(self) -> None:
        state = self._round_state()
        state["heldOutInspectionStartedAt"] = "2026-07-26T02:00:00Z"
        state["profileFrozenAt"] = "2026-07-26T03:00:00Z"
        with self.assertRaisesRegex(ContractError, "before held-out"):
            validate_round_state(state, self.contract, self.candidates)

    def test_memory_failure_blocks_pareto_review(self) -> None:
        state = self._round_state()
        state["candidateStates"][0]["hardGateResults"][
            "incrementalPeakRssBytes"
        ] = "FAIL"
        state["candidateStates"][0]["paretoEligible"] = True
        with self.assertRaisesRegex(ContractError, "hard gate"):
            validate_round_state(state, self.contract, self.candidates)

    def test_no_material_benefit_requires_baseline_retention(self) -> None:
        state = self._round_state()
        state["roundOutcome"] = "RECOMMEND_REPLACEMENT"
        with self.assertRaisesRegex(ContractError, "retain"):
            validate_round_state(state, self.contract, self.candidates)

    def _candidate(self, candidate_id: str) -> dict:
        return next(
            candidate
            for candidate in self.candidates["candidates"]
            if candidate["candidateId"] == candidate_id
        )

    def _round_state(self) -> dict:
        return {
            "schemaVersion": 2,
            "contractId": self.contract["contractId"],
            "profileFrozenAt": "2026-07-26T01:00:00Z",
            "heldOutInspectionStartedAt": None,
            "materialBenefitFrozen": True,
            "candidateStates": [
                {
                    "candidateId": self.contract["baselineCandidateId"],
                    "stage": "STAGE_1_SHORT",
                    "terminalDisposition": None,
                    "hardGateResults": {
                        "cer": "PASS",
                        "rtf": "PASS",
                        "incrementalPeakRssBytes": "NOT_APPLICABLE",
                    },
                    "materialBenefit": False,
                    "paretoEligible": False,
                }
            ],
            "roundOutcome": "RETAIN_BASELINE_NO_MATERIAL_BENEFIT",
        }


if __name__ == "__main__":
    unittest.main()
