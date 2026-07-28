from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from evaluate_live_caption import (
    DEFAULT_CONTRACT,
    DEFAULT_OPTIMIZATION_CONTRACT,
    LiveCaptionError,
    build_optimization_profiles,
    optimization_scenario_error_rate,
    select_optimization_final_decision,
    select_optimization_finalist,
    validate_contract,
    validate_evidence,
    validate_fixture_manifest,
    validate_integration_probe,
    validate_optimization_contract,
)


class LiveCaptionEvaluatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(DEFAULT_CONTRACT.read_text(encoding="utf-8"))
        cls.manifest = json.loads(
            Path(cls.contract["inputs"]["fixtureManifestPath"]).read_text(
                encoding="utf-8"
            )
        )

    def test_frozen_contract_and_fixture_pack_are_valid(self) -> None:
        validate_contract(self.contract)
        validate_fixture_manifest(self.manifest)

    def test_baseline_cannot_change_itn_threads_or_vad(self) -> None:
        for field, value in (
            ("useInverseTextNormalization", True),
            ("threads", 3),
            ("vadThreshold", 0.4),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.contract)
                changed["control"][field] = value
                with self.assertRaisesRegex(LiveCaptionError, "control changed"):
                    validate_contract(changed, validate_files=False)

    def test_held_out_rows_cannot_overlap_development(self) -> None:
        changed = copy.deepcopy(self.manifest)
        development = next(
            item
            for item in changed["fixtures"]
            if item["fixtureRole"] == "development"
            and item["sourceRows"]
        )
        held_out = next(
            item
            for item in changed["fixtures"]
            if item["fixtureRole"] == "held_out"
        )
        held_out["sourceRows"].append(development["sourceRows"][0])
        with self.assertRaisesRegex(LiveCaptionError, "source rows overlap"):
            validate_fixture_manifest(changed)

    def test_offline_rtf_cannot_substitute_live_latency(self) -> None:
        evidence = self._passing_evidence()
        evidence["latency"] = {"offlineRtf": 0.1}
        with self.assertRaisesRegex(LiveCaptionError, "latency p50"):
            validate_evidence(evidence, self.contract)

    def test_fake_token_partials_fail_closed(self) -> None:
        evidence = self._passing_evidence()
        evidence["tokenPartialCount"] = 1
        with self.assertRaisesRegex(LiveCaptionError, "fake token partial"):
            validate_evidence(evidence, self.contract)

    def test_gate_failure_marks_caption_unavailable(self) -> None:
        evidence = self._passing_evidence()
        evidence["latency"]["speechEndToVisibleP95Ms"] = 2001
        self.assertEqual(
            validate_evidence(evidence, self.contract)["status"],
            "UNAVAILABLE",
        )

    def test_real_flutter_capture_probe_is_bound_and_lossless(self) -> None:
        probe = json.loads(
            (
                DEFAULT_CONTRACT.parent
                / "evidence/macos/u13-flutter-capture-probe.json"
            ).read_text(encoding="utf-8")
        )
        metrics = validate_integration_probe(
            probe,
            self.contract,
            self.manifest,
        )
        self.assertEqual(0, metrics["captureFrameLossDelta"])
        self.assertGreater(metrics["maximumFlutterAppRssBytes"], 0)
        self.assertGreater(metrics["resultToVisibleP95Ms"], 0)

    def test_u18_contract_is_target_bound_and_single_variable(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        validate_optimization_contract(contract)
        profiles = build_optimization_profiles(contract)
        control = profiles[0]["config"]
        self.assertEqual(14, len(profiles))
        for profile in profiles[1:]:
            self.assertEqual(
                {profile["changedVariable"]},
                {
                    key
                    for key in control
                    if control.get(key) != profile["config"].get(key)
                },
            )

    def test_u18_rejects_target_drift_or_unlicensed_model_promotion(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        changed = copy.deepcopy(contract)
        changed["target"]["cpu"] = "Apple M2"
        with self.assertRaisesRegex(LiveCaptionError, "target"):
            validate_optimization_contract(changed, validate_files=False)

        changed = copy.deepcopy(contract)
        changed["models"]["sensevoice-int8-2025-09-09"][
            "promotionEligible"
        ] = True
        with self.assertRaisesRegex(LiveCaptionError, "unlicensed"):
            validate_optimization_contract(changed, validate_files=False)

    def test_u18_rejects_multi_variable_arm(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        contract["arms"][0]["threads"] = 3
        with self.assertRaisesRegex(LiveCaptionError, "multiple-variable"):
            validate_optimization_contract(contract, validate_files=False)

    def test_u18_promotes_only_an_arm_that_clears_every_guardrail(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        arms = self._optimization_summaries(contract)
        by_id = {arm["id"]: arm for arm in arms}
        by_id["threads-3"]["warmUtteranceP95Ms"] = 80.0
        by_id["threads-3"]["maximumUtteranceSeconds"] = 15.000000000000002

        decision = select_optimization_finalist(arms, contract)
        self.assertEqual("OPTIMIZATION_SCREENED_IN", decision["status"])
        self.assertEqual("threads-3", decision["selectedArm"])

        by_id["threads-3"]["codeSwitchErrorRate"] = 0.104
        decision = select_optimization_finalist(arms, contract)
        self.assertEqual("CONTROL_RETAINED", decision["status"])

    def test_u18_unlicensed_model_cannot_promote_even_when_faster(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        arms = self._optimization_summaries(contract)
        by_id = {arm["id"]: arm for arm in arms}
        by_id["model-2025-09-09"]["warmUtteranceP95Ms"] = 10.0

        decision = select_optimization_finalist(arms, contract)
        self.assertEqual("CONTROL_RETAINED", decision["status"])
        self.assertEqual("control", decision["selectedArm"])

    def test_u18_non_speech_uses_hallucination_score_without_lexical_rate(
        self,
    ) -> None:
        lexical = {"cer": None, "wer": None}
        self.assertEqual(
            0.0,
            optimization_scenario_error_rate("non_speech", "", lexical),
        )
        self.assertEqual(
            1.0,
            optimization_scenario_error_rate(
                "non_speech",
                "unexpected speech",
                lexical,
            ),
        )

    def test_u18_finalist_must_pass_held_out_guardrails(self) -> None:
        contract = json.loads(
            DEFAULT_OPTIMIZATION_CONTRACT.read_text(encoding="utf-8")
        )
        arms = self._optimization_summaries(contract)
        by_id = {arm["id"]: arm for arm in arms}
        candidate = copy.deepcopy(by_id["vad-threshold-0.4"])
        candidate["errorRate"] = by_id["control"]["errorRate"] - 0.01
        candidate["nonTargetErrorRate"] = (
            by_id["control"]["nonTargetErrorRate"] + 0.004
        )
        screening = {
            "selection": {
                "status": "OPTIMIZATION_SCREENED_IN",
                "selectedArm": candidate["id"],
            }
        }
        retained = select_optimization_final_decision(
            screening=screening,
            finalist={"arms": [candidate]},
            control=by_id["control"],
            contract=contract,
        )
        self.assertEqual("CONTROL_RETAINED", retained["status"])
        self.assertFalse(retained["gates"]["nonTargetNonRegression"])

        candidate["nonTargetErrorRate"] = by_id["control"]["nonTargetErrorRate"]
        admitted = select_optimization_final_decision(
            screening=screening,
            finalist={"arms": [candidate]},
            control=by_id["control"],
            contract=contract,
        )
        self.assertEqual("OPTIMIZATION_ADMITTED", admitted["status"])

    def test_flutter_capture_probe_rejects_uncommitted_frames(self) -> None:
        probe = json.loads(
            (
                DEFAULT_CONTRACT.parent
                / "evidence/macos/u13-flutter-capture-probe.json"
            ).read_text(encoding="utf-8")
        )
        probe["captureAccounting"]["concurrent"]["microphone"][
            "committedFrames"
        ] -= 1
        with self.assertRaisesRegex(LiveCaptionError, "frame accounting failed"):
            validate_integration_probe(probe, self.contract, self.manifest)

    def _passing_evidence(self) -> dict:
        scenarios = self.manifest["requiredScenarios"]
        return {
            "schemaVersion": 1,
            "contractId": self.contract["contractId"],
            "status": "COMPLETE",
            "target": self.contract["target"],
            "bindings": {
                "fixtureManifestSha256": self.contract["inputs"][
                    "fixtureManifestSha256"
                ],
                "scorerSha256": self.contract["inputs"]["scorerSha256"],
                "modelArchiveSha256": self.contract["model"]["archiveSha256"],
                "sileroVadSha256": self.contract["vad"]["sha256"],
            },
            "effectiveConfig": self.contract["control"],
            "tokenPartialCount": 0,
            "invalidWorkerEventCount": 0,
            "captureFrameLossDelta": 0,
            "quality": [
                {
                    "scenario": scenario,
                    "errorRate": 0.1,
                    "completeInputConsumed": True,
                    "offsetsValid": True,
                }
                for scenario in scenarios
            ],
            "latency": {
                "speechEndToVisibleP50Ms": 800,
                "speechEndToVisibleP95Ms": 1500,
                "maximumBacklogSeconds": 1,
            },
            "resources": {
                "maximumAppRssBytes": 900_000_000,
                "uiLongFrameRate": 0,
            },
            "stability": {
                "durationSeconds": 900,
                "crashed": False,
                "oom": False,
                "maximumUtteranceSeconds": 15,
            },
        }

    @staticmethod
    def _optimization_summaries(contract: dict) -> list[dict]:
        return [
            {
                "id": profile["id"],
                "effectiveConfig": profile["config"],
                "errorRate": 0.1,
                "nonTargetErrorRate": 0.1,
                "codeSwitchErrorRate": 0.1,
                "numericEventAccuracy": 1.0,
                "itnEventAccuracy": 1.0,
                "warmUtteranceP95Ms": 100.0,
                "maximumRssBytes": 100_000_000,
                "maximumBacklogSeconds": 0.0,
                "maximumUtteranceSeconds": 10.0,
                "retainedRssBytesAfterWorkerExit": 0,
                "completeInputConsumed": True,
                "shortConfirmationDetected": True,
                "hallucinated": False,
            }
            for profile in build_optimization_profiles(contract)
        ]


if __name__ == "__main__":
    unittest.main()
