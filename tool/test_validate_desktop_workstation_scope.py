from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from tool.validate_desktop_workstation_scope import (
    DEFAULT_MANIFEST,
    _validate_qwen3_product_decision,
    _validate_u12_capture_evidence,
    _validate_u13_live_caption_evidence,
    validate_asr005_policy_text,
    validate_scope_contract,
)


class DesktopWorkstationScopeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))

    def _validate_mutation(self, manifest: dict) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "scope.json"
            path.write_text(
                json.dumps(manifest, ensure_ascii=False),
                encoding="utf-8",
            )
            validate_scope_contract(path, validate_documents=False)

    def test_repository_scope_declares_serial_desktop_direction(self) -> None:
        result = validate_scope_contract()

        self.assertEqual("macos", result["firstDesktopTarget"])
        self.assertEqual("PRODUCT_IN_PROGRESS", result["macos"])
        self.assertEqual("BLOCKED_BY_MACOS_CLOSURE", result["windows"])
        self.assertEqual("PASS_MACOS_ANDROID_LAN", result["lanHandoff"])
        self.assertEqual(
            "FAIL_NO_ADMISSIBLE_CANDIDATE",
            result["mobileDiarizationFinalDiagnostic"],
        )

    def test_macos_and_windows_cannot_be_developed_in_parallel(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["productDirection"]["platformExecution"] = "PARALLEL"

        with self.assertRaisesRegex(ValueError, "macOS before Windows"):
            self._validate_mutation(manifest)

    def test_windows_pass_requires_macos_closure_evidence(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["targets"]["macos"]["status"] = "PRODUCT_IN_PROGRESS"
        manifest["targets"]["macos"]["closureStatus"] = "NOT_RUN"
        manifest["targets"]["windows"]["status"] = "PASS"

        with self.assertRaisesRegex(ValueError, "macOS closure PASS"):
            self._validate_mutation(manifest)

    def test_qwen3_product_decision_cannot_drift(self) -> None:
        for field, value in (
            ("asrCandidateId", "another-model"),
            ("asrCandidateCount", 2),
            ("runtimeLaneId", "another-runtime"),
        ):
            with self.subTest(field=field):
                manifest = copy.deepcopy(self.manifest)
                decision_path = Path(
                    manifest["targets"]["macos"]["frozenEngines"][
                        "machineDecision"
                    ]
                )
                decision = json.loads(decision_path.read_text(encoding="utf-8"))
                decision["product"][field] = value
                with self.assertRaisesRegex(
                    ValueError,
                    "frozen engines disagree",
                ):
                    _validate_qwen3_product_decision(
                        decision,
                        manifest["targets"]["macos"]["frozenEngines"],
                    )
        manifest = copy.deepcopy(self.manifest)
        decision_path = Path(
            manifest["targets"]["macos"]["frozenEngines"]["machineDecision"]
        )
        decision = json.loads(decision_path.read_text(encoding="utf-8"))
        decision["product"]["profile"]["maxTotalLen"] = 256
        with self.assertRaisesRegex(ValueError, "frozen engines disagree"):
            _validate_qwen3_product_decision(
                decision,
                manifest["targets"]["macos"]["frozenEngines"],
            )

    def test_target_cannot_reuse_another_targets_only_evidence_hash(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        reused_hash = "a" * 64
        manifest["targets"]["android"]["evidence"] = [
            {"path": "benchmark/evidence/android.json", "sha256": reused_hash}
        ]
        manifest["targets"]["macos"]["evidence"] = [
            {"path": "benchmark/evidence/macos.json", "sha256": reused_hash}
        ]

        with self.assertRaisesRegex(ValueError, "reused across targets"):
            self._validate_mutation(manifest)

    def test_asr005_cannot_return_to_development_blockers_or_reminders(self) -> None:
        forbidden_examples = (
            "Development blockers: ASR-005",
            "开发阻塞：ASR-005 独立听审",
            "Daily reminder: complete ASR-005",
            "日常提醒：完成 ASR-005",
        )

        for text in forbidden_examples:
            with self.subTest(text=text):
                with self.assertRaisesRegex(ValueError, "ASR-005"):
                    validate_asr005_policy_text(text, "fixture")

    def test_asr005_user_owned_release_acceptance_is_allowed(self) -> None:
        validate_asr005_policy_text(
            "ASR-005 is USER_PRE_RELEASE_ACCEPTANCE_ONLY and is excluded from "
            "development blockers and automated reminders.",
            "fixture",
        )

    def test_mobile_diagnostic_cannot_reopen_candidate_loop(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["mobileDiarizationFinalDiagnostic"]["autoContinueCandidates"] = True

        with self.assertRaisesRegex(ValueError, "candidate loop"):
            self._validate_mutation(manifest)

    def test_terminal_mobile_diagnostic_is_bound_to_summary_hash(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["mobileDiarizationFinalDiagnostic"]["summarySha256"] = "0" * 64

        with self.assertRaisesRegex(ValueError, "summary hash mismatch"):
            self._validate_mutation(manifest)

    def test_lan_pass_is_bound_to_evidence_hash(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["lanHandoff"]["evidence"]["sha256"] = "0" * 64

        with self.assertRaisesRegex(ValueError, "LAN PASS evidence hash mismatch"):
            self._validate_mutation(manifest)

    def test_desktop_expansion_cannot_require_mobile_product_changes(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["mobileUiChangesAllowed"] = True

        with self.assertRaisesRegex(ValueError, "mobile implementation or UI"):
            self._validate_mutation(manifest)

    def test_expanded_windows_capabilities_stay_blocked(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["capture"]["windowsStatus"] = "PLANNED"

        with self.assertRaisesRegex(ValueError, "cannot unlock Windows"):
            self._validate_mutation(manifest)

    def test_macos_development_reference_target_cannot_drift(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["targets"]["macos"]["developmentReferenceTarget"]["cpu"] = (
            "Apple M2"
        )

        with self.assertRaisesRegex(ValueError, "reference target drifted"):
            self._validate_mutation(manifest)

    def test_capture_cannot_claim_completion_without_physical_evidence(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["capture"]["evidencePath"] = (
            "benchmark/desktop/capture/evidence/macos_m4_dual_track_smoke.json"
        )

        with self.assertRaisesRegex(ValueError, "physical evidence"):
            self._validate_mutation(manifest)

    def test_capture_cannot_use_screen_recording_as_audio_fallback(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["capture"]["capturesScreenPixels"] = True

        with self.assertRaisesRegex(ValueError, "screen pixels"):
            self._validate_mutation(manifest)

    def test_capture_pass_requires_all_actual_process_termination_stages(self) -> None:
        feasibility = json.loads(
            Path(
                "benchmark/desktop/capture/macos_capture_feasibility.json"
            ).read_text(encoding="utf-8")
        )
        binding = feasibility["u12Evidence"]
        evidence = json.loads(Path(binding["path"]).read_text(encoding="utf-8"))
        evidence["actualProcessTermination"]["stages"].pop()

        with self.assertRaisesRegex(ValueError, "termination evidence"):
            _validate_u12_capture_evidence(evidence)

    def test_u13_live_caption_evidence_is_target_bound(self) -> None:
        capability = self.manifest["expandedDesktopCapabilities"]["liveCaption"]
        summary = json.loads(
            Path(capability["evidencePath"]).read_text(encoding="utf-8")
        )
        decision = json.loads(
            Path(capability["decisionPath"]).read_text(encoding="utf-8")
        )
        summary["target"]["cpu"] = "Apple M2"

        with self.assertRaisesRegex(ValueError, "target-bound"):
            _validate_u13_live_caption_evidence(summary, decision)

    def test_u13_live_caption_cannot_hide_capture_loss(self) -> None:
        capability = self.manifest["expandedDesktopCapabilities"]["liveCaption"]
        summary = json.loads(
            Path(capability["evidencePath"]).read_text(encoding="utf-8")
        )
        decision = json.loads(
            Path(capability["decisionPath"]).read_text(encoding="utf-8")
        )
        summary["captureFrameLossDelta"] = 1

        with self.assertRaisesRegex(ValueError, "capture gates"):
            _validate_u13_live_caption_evidence(summary, decision)

    def test_macos_capability_floors_cannot_collapse_to_one_version(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["capture"][
            "applicationMinimumMacosVersion"
        ] = "15.5"

        with self.assertRaisesRegex(ValueError, "minimum macOS contract"):
            self._validate_mutation(manifest)

    def test_macos_13_microphone_fallback_cannot_silently_disappear(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["capture"][
            "lowerVersionBehavior"
        ] = "BLOCK_ALL_CAPTURE"

        with self.assertRaisesRegex(ValueError, "lower-version behavior"):
            self._validate_mutation(manifest)

    def test_routine_probe_limit_cannot_exceed_thirty_minutes(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["expandedDesktopCapabilities"]["maximumProbeMinutes"] = 31

        with self.assertRaisesRegex(ValueError, "30 minutes"):
            self._validate_mutation(manifest)

    def test_vertical_slice_runner_uses_only_qwen3_product_arguments(self) -> None:
        script = Path(
            "benchmark/desktop/run_offline_vertical_slice.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("sherpa-onnx-qwen3-asr-0.6B-int8", script)
        for argument in (
            "--conv-frontend",
            "--encoder",
            "--decoder",
            "--tokenizer",
        ):
            self.assertIn(argument, script)
        self.assertNotIn("--joiner", script)
        self.assertNotIn("--tokens", script)


if __name__ == "__main__":
    unittest.main()
