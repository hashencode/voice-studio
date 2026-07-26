from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from tool.validate_desktop_workstation_scope import (
    DEFAULT_MANIFEST,
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
        self.assertEqual("PASS", result["macos"])
        self.assertEqual("PLANNED", result["windows"])
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


if __name__ == "__main__":
    unittest.main()
