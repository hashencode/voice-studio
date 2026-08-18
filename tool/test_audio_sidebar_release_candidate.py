from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).with_name(
    "audio_sidebar_release_candidate.py"
)
SPEC = importlib.util.spec_from_file_location(
    "audio_sidebar_release_candidate", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AudioSidebarReleaseCandidateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.package = self.root / "Voice2Text.app"
        self.release = self.root / "release"
        self.candidate_receipt = self.release / "candidate.json"
        self.manual_receipt = self.release / "manual.json"
        self.final_receipt = self.release / "final.json"
        self.manual_definition = self.root / "manual-checks.json"
        self.product_manifest = self.root / "workstation.json"
        executable = self.package / "Contents/MacOS/Voice2Text"
        worker = self.package / "Contents/Resources/worker/manifest.json"
        executable.parent.mkdir(parents=True)
        worker.parent.mkdir(parents=True)
        executable.write_bytes(b"candidate executable")
        worker.write_text('{"schemaVersion":1}\n', encoding="utf-8")
        self.candidate = {
            "sourceRevision": "1" * 40,
            "candidateInputsSha256": "2" * 64,
            "target": {"sha256": "3" * 64},
            "package": {
                "manifestSha256": MODULE.package_tree_sha256(self.package)
            },
        }
        definition = json.loads(MODULE.MANUAL_DEFINITION.read_text(encoding="utf-8"))
        self.manual_definition.write_text(
            json.dumps(definition) + "\n", encoding="utf-8"
        )
        self.manual = {
            "schema": "voice2text-audio-sidebar-manual-receipt/v1",
            "status": "PASS",
            "sourceRevision": "1" * 40,
            "packageManifestSha256": self.candidate["package"]["manifestSha256"],
            "targetSha256": "3" * 64,
            "startedAt": "2026-08-17T12:00:00Z",
            "finishedAt": "2026-08-17T12:10:00Z",
            "elapsedMs": 600_000,
            "operator": "bounded-test-operator",
            "checks": [
                {"id": item["id"], "status": "PASS"}
                for item in definition["checks"]
            ],
        }

    def _patch_release_paths(self) -> ExitStack:
        stack = ExitStack()
        stack.enter_context(patch.object(MODULE, "ROOT", self.root))
        stack.enter_context(patch.object(MODULE, "PACKAGE_PATH", self.package))
        stack.enter_context(
            patch.object(MODULE, "CANDIDATE_RECEIPT", self.candidate_receipt)
        )
        stack.enter_context(
            patch.object(MODULE, "MANUAL_RECEIPT", self.manual_receipt)
        )
        stack.enter_context(patch.object(MODULE, "FINAL_RECEIPT", self.final_receipt))
        stack.enter_context(
            patch.object(MODULE, "MANUAL_DEFINITION", self.manual_definition)
        )
        stack.enter_context(
            patch.object(MODULE, "PRODUCT_MANIFEST", self.product_manifest)
        )
        return stack

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_complete_manual_receipt_matches_one_candidate(self) -> None:
        MODULE.validate_manual(self.candidate, self.manual)

    def test_missing_manual_result_blocks_finalize(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["checks"][-1]["status"] = "PENDING"
        with self.assertRaisesRegex(MODULE.CandidateError, "incomplete"):
            MODULE.validate_manual(self.candidate, manual)

    def test_manual_package_identity_cannot_be_rebound(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["packageManifestSha256"] = "4" * 64
        with self.assertRaisesRegex(MODULE.CandidateError, "package identity"):
            MODULE.validate_manual(self.candidate, manual)

    def test_manual_timestamps_must_be_utc_rfc3339(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["startedAt"] = "2026-08-17 12:00:00"
        with self.assertRaisesRegex(MODULE.CandidateError, "start time is invalid"):
            MODULE.validate_manual(self.candidate, manual)

    def test_manual_finish_must_not_precede_start(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["finishedAt"] = "2026-08-17T11:59:59Z"
        manual["elapsedMs"] = 1
        with self.assertRaisesRegex(MODULE.CandidateError, "precedes start"):
            MODULE.validate_manual(self.candidate, manual)

    def test_manual_elapsed_must_match_timestamps(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["elapsedMs"] = 599_999
        with self.assertRaisesRegex(MODULE.CandidateError, "does not match"):
            MODULE.validate_manual(self.candidate, manual)

    def test_boolean_manual_elapsed_is_rejected(self) -> None:
        manual = copy.deepcopy(self.manual)
        manual["elapsedMs"] = True
        with self.assertRaisesRegex(MODULE.CandidateError, "elapsed time is invalid"):
            MODULE.validate_manual(self.candidate, manual)

    def test_changed_package_is_rejected(self) -> None:
        with patch.object(MODULE, "PACKAGE_PATH", self.package), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ):
            MODULE.verify_candidate_identity(self.candidate)
            (self.package / "Contents/MacOS/Voice2Text").write_bytes(b"changed")
            with self.assertRaisesRegex(MODULE.CandidateError, "package changed"):
                MODULE.verify_candidate_identity(self.candidate)

    def test_changed_source_revision_is_rejected(self) -> None:
        with patch.object(MODULE, "PACKAGE_PATH", self.package), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("9" * 40, "2" * 64),
        ), patch.object(
            MODULE,
            "_is_ancestor",
            return_value=False,
        ):
            with self.assertRaisesRegex(MODULE.CandidateError, "not an ancestor"):
                MODULE.verify_candidate_identity(self.candidate)

    def test_descendant_with_identical_package_inputs_is_allowed(self) -> None:
        with patch.object(MODULE, "PACKAGE_PATH", self.package), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("9" * 40, "2" * 64),
        ), patch.object(MODULE, "_is_ancestor", return_value=True):
            MODULE.verify_candidate_identity(self.candidate)

    def test_candidate_inputs_bind_mobile_manual_definition_and_gate(self) -> None:
        self.assertIn("apps/mobile-flutter", MODULE.INPUT_PATHS)
        self.assertIn(
            "docs/product/audio-sidebar-manual-checks.json", MODULE.INPUT_PATHS
        )
        self.assertIn("tool/audio_sidebar_release_candidate.py", MODULE.INPUT_PATHS)
        self.assertIn(
            "tool/validate_audio_sidebar_workstation.py", MODULE.INPUT_PATHS
        )

    def test_packaged_matrix_explicitly_enables_every_opt_in_file(self) -> None:
        packaged = {
            identifier: tuple(command)
            for identifier, command, _cwd in MODULE.PREPARE_COMMANDS
            if identifier.startswith("packaged-")
        }
        self.assertEqual(
            packaged,
            {
                "packaged-bootstrap-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_SMOKE=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_bootstrap_smoke_test.ts",
                ),
                "packaged-processing-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_PROCESSING=1",
                    "RUN_DIRECT_PACKAGED_PROCESSING=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_processing_smoke_test.ts",
                ),
                "packaged-workstation-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_WORKSTATION=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_local_workstation_dogfood_test.ts",
                ),
                "packaged-companion-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_COMPANION_SMOKE=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_companion_smoke_test.ts",
                ),
                "packaged-capture-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_CAPTURE_INITIALIZE_ONLY=0",
                    "RUN_PACKAGED_CAPTURE_SMOKE=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_capture_recovery_smoke_test.ts",
                ),
                "packaged-live-caption-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_LIVE_CAPTION=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_live_caption_worker_smoke_test.ts",
                ),
                "packaged-caption-formal-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_CAPTION_FORMAL=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_caption_formal_smoke_test.ts",
                ),
                "packaged-ai-boundary-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_AI_BOUNDARY=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_ai_boundary_smoke_test.ts",
                ),
                "packaged-native-security-test": (
                    "/usr/bin/env",
                    "RUN_PACKAGED_NATIVE_SECURITY_SMOKE=1",
                    "bunx",
                    "vitest",
                    "run",
                    "tests/packaged/macos_native_security_helper_smoke_test.ts",
                ),
            },
        )

    def test_prepare_recovers_missing_manual_without_rerunning_commands(self) -> None:
        commands: list[tuple[str, ...]] = []
        original_write = MODULE._write_json
        fail_manual_once = True

        def flaky_write(path: pathlib.Path, value: object) -> None:
            nonlocal fail_manual_once
            if path == self.manual_receipt and fail_manual_once:
                fail_manual_once = False
                raise OSError("manual projection failed")
            original_write(path, value)

        with self._patch_release_paths(), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ), patch.object(
            MODULE,
            "target_fingerprint",
            return_value={"sha256": "3" * 64},
        ), patch.object(MODULE, "_write_json", side_effect=flaky_write):
            with self.assertRaisesRegex(OSError, "manual projection failed"):
                MODULE.prepare(
                    runner=lambda command, _cwd: commands.append(tuple(command))
                )
            self.assertTrue(self.candidate_receipt.is_file())
            self.assertFalse(self.manual_receipt.exists())
            first_run_count = len(commands)
            recovered = MODULE.prepare(
                runner=lambda _command, _cwd: self.fail("commands reran")
            )

        self.assertEqual(first_run_count, len(MODULE.PREPARE_COMMANDS))
        self.assertEqual(recovered["sourceRevision"], "1" * 40)
        self.assertEqual(
            json.loads(self.manual_receipt.read_text(encoding="utf-8"))["status"],
            "PENDING",
        )

    def test_changed_candidate_input_tree_is_rejected(self) -> None:
        with patch.object(MODULE, "PACKAGE_PATH", self.package), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "9" * 64),
        ):
            with self.assertRaisesRegex(MODULE.CandidateError, "input tree changed"):
                MODULE.verify_candidate_identity(self.candidate)

    def test_prepare_rejects_conflicting_existing_candidate_without_rerun(self) -> None:
        candidate = copy.deepcopy(self.candidate)
        candidate["schema"] = "voice2text-audio-sidebar-candidate/v1"
        candidate["status"] = "AUTOMATED_PASS_MANUAL_PENDING"
        candidate["candidateInputsSha256"] = "9" * 64
        self.candidate_receipt.parent.mkdir(parents=True)
        self.candidate_receipt.write_text(json.dumps(candidate), encoding="utf-8")
        with self._patch_release_paths(), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ):
            with self.assertRaisesRegex(MODULE.CandidateError, "input tree changed"):
                MODULE.prepare(
                    runner=lambda _command, _cwd: self.fail("commands ran")
                )

    def test_finalize_recovers_product_projection_without_rewriting_final(self) -> None:
        candidate = copy.deepcopy(self.candidate)
        candidate["schema"] = "voice2text-audio-sidebar-candidate/v1"
        candidate["status"] = "AUTOMATED_PASS_MANUAL_PENDING"
        candidate["target"] = {"sha256": "3" * 64}
        self.candidate_receipt.parent.mkdir(parents=True)
        self.candidate_receipt.write_text(json.dumps(candidate), encoding="utf-8")
        self.manual_receipt.write_text(json.dumps(self.manual), encoding="utf-8")
        self.product_manifest.write_text(
            json.dumps(
                {
                    "status": "DEVELOPMENT_COMPLETE_RELEASE_VALIDATION_PENDING",
                    "releaseCandidate": {
                        "status": "PENDING_U6_STABLE_CANDIDATE"
                    },
                }
            ),
            encoding="utf-8",
        )
        original_write = MODULE._write_json
        fail_product_once = True

        def flaky_write(path: pathlib.Path, value: object) -> None:
            nonlocal fail_product_once
            if path == self.product_manifest and fail_product_once:
                fail_product_once = False
                raise OSError("product projection failed")
            original_write(path, value)

        with self._patch_release_paths(), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ), patch.object(MODULE, "_timestamp", return_value="2026-08-17T12:11:00Z"), patch.object(
            MODULE, "_write_json", side_effect=flaky_write
        ):
            with self.assertRaisesRegex(OSError, "product projection failed"):
                MODULE.finalize()
            original_final = self.final_receipt.read_bytes()
            recovered = MODULE.finalize()

        self.assertEqual(self.final_receipt.read_bytes(), original_final)
        self.assertEqual(recovered["rebuildPerformed"], False)
        product = json.loads(self.product_manifest.read_text(encoding="utf-8"))
        self.assertEqual(product["status"], "RELEASE_VALIDATED")
        self.assertEqual(product["releaseCandidate"]["sourceRevision"], "1" * 40)

    def test_finalize_rejects_conflicting_existing_final(self) -> None:
        candidate = copy.deepcopy(self.candidate)
        candidate["schema"] = "voice2text-audio-sidebar-candidate/v1"
        candidate["status"] = "AUTOMATED_PASS_MANUAL_PENDING"
        self.candidate_receipt.parent.mkdir(parents=True)
        self.candidate_receipt.write_text(json.dumps(candidate), encoding="utf-8")
        self.manual_receipt.write_text(json.dumps(self.manual), encoding="utf-8")
        self.final_receipt.write_text(
            json.dumps(
                {
                    "schema": "voice2text-audio-sidebar-final/v1",
                    "status": "PASS",
                    "sourceRevision": "9" * 40,
                    "candidateInputsSha256": "2" * 64,
                    "packageManifestSha256": candidate["package"][
                        "manifestSha256"
                    ],
                    "targetSha256": "3" * 64,
                    "candidateReceiptSha256": MODULE._sha256_file(
                        self.candidate_receipt
                    ),
                    "manualReceiptSha256": MODULE._sha256_file(
                        self.manual_receipt
                    ),
                    "finalizedAt": "2026-08-17T12:11:00Z",
                    "rebuildPerformed": False,
                }
            ),
            encoding="utf-8",
        )
        with self._patch_release_paths(), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ):
            with self.assertRaisesRegex(MODULE.CandidateError, "final receipt conflicts"):
                MODULE.finalize()

    def test_finalize_rejects_conflicting_product_projection(self) -> None:
        candidate = copy.deepcopy(self.candidate)
        candidate["schema"] = "voice2text-audio-sidebar-candidate/v1"
        candidate["status"] = "AUTOMATED_PASS_MANUAL_PENDING"
        self.candidate_receipt.parent.mkdir(parents=True)
        self.candidate_receipt.write_text(json.dumps(candidate), encoding="utf-8")
        self.manual_receipt.write_text(json.dumps(self.manual), encoding="utf-8")
        self.product_manifest.write_text(
            json.dumps(
                {
                    "status": "RELEASE_VALIDATED",
                    "releaseCandidate": {
                        "status": "PASS",
                        "sourceRevision": "9" * 40,
                    },
                }
            ),
            encoding="utf-8",
        )
        with self._patch_release_paths(), patch.object(
            MODULE,
            "committed_candidate_identity",
            return_value=("1" * 40, "2" * 64),
        ), patch.object(MODULE, "_timestamp", return_value="2026-08-17T12:11:00Z"):
            with self.assertRaisesRegex(
                MODULE.CandidateError, "product projection conflicts"
            ):
                MODULE.finalize()


if __name__ == "__main__":
    unittest.main()
