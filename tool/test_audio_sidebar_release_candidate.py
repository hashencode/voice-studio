from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
