from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name(
    "validate_audio_sidebar_workstation.py"
)
SPEC = importlib.util.spec_from_file_location(
    "validate_audio_sidebar_workstation", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AudioSidebarWorkstationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads(MODULE.MANIFEST.read_text(encoding="utf-8"))

    def _validate_manifest(self, manifest: dict[str, object]) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        ) as handle:
            json.dump(manifest, handle)
            path = pathlib.Path(handle.name)
        try:
            MODULE.validate(manifest_path=path)
        finally:
            path.unlink()

    def test_repository_contract_is_current(self) -> None:
        MODULE.validate()

    def test_visually_divergent_candidate_remains_archived_and_ineligible(self) -> None:
        release_directory = MODULE.ROOT / "docs/product/audio-sidebar-release"
        invalidated_revision = "17a939231d886d6f2af1cc31843d04bfc725a1a9"
        self.assertNotEqual(
            self.manifest["releaseCandidate"]["sourceRevision"],
            invalidated_revision,
        )
        expected_hashes = {
            "candidate.json": "8e22b233d7113f0480494ad94e198189c19967106b5e2c8f03fd56eb47a36138",
            "manual.json": "d2c6d4737704c1869a1a3d84d1109eb94d3edeec40a5acbc46e7de8baa4c0ba8",
            "final.json": "0aa01aae0994e0a605fef2aaaf1b097042d67787382469ff5cf1a048e551f236",
        }
        invalidations = []
        for path in (release_directory / "superseded").glob("*/invalidation.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("sourceRevision") == invalidated_revision:
                invalidations.append((path, value))
        self.assertEqual(len(invalidations), 1)

        invalidation_path, invalidation = invalidations[0]
        self.assertEqual(
            invalidation.get("schema"),
            "voice2text-audio-sidebar-candidate-invalidation/v1",
        )
        self.assertEqual(
            invalidation.get("status"),
            "SUPERSEDED_VISUAL_FIDELITY_INVALIDATED",
        )
        self.assertFalse(invalidation.get("eligibleAsCurrentEvidence"))
        reason = invalidation.get("reason")
        self.assertIsInstance(reason, str)
        self.assertIn("sidebar-09", reason)
        self.assertIn("visual", reason.lower())
        self.assertEqual(invalidation.get("receipts"), expected_hashes)

        archive_directory = invalidation_path.parent
        for name, expected_hash in expected_hashes.items():
            archived_receipt = archive_directory / name
            self.assertTrue(archived_receipt.is_file())
            self.assertEqual(
                hashlib.sha256(archived_receipt.read_bytes()).hexdigest(),
                expected_hash,
            )

    def test_fourth_rail_destination_is_rejected(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["navigation"]["rail"].append(
            {"id": "tasks", "label": "Tasks"}
        )
        with self.assertRaisesRegex(MODULE.AudioSidebarValidationError, "exactly"):
            self._validate_manifest(manifest)

    def test_pending_candidate_cannot_reuse_historical_receipt(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["status"] = "DEVELOPMENT_COMPLETE_RELEASE_VALIDATION_PENDING"
        candidate = manifest["releaseCandidate"]
        candidate["status"] = "PENDING_U6_STABLE_CANDIDATE"
        candidate["sourceRevision"] = None
        candidate["packageManifestSha256"] = None
        candidate["automatedReceipt"] = (
            "docs/product/desktop-electron-evidence.json"
        )
        candidate["manualReceipt"] = None
        with self.assertRaisesRegex(MODULE.AudioSidebarValidationError, "must not bind"):
            self._validate_manifest(manifest)

    def test_pending_candidate_cannot_claim_release_validated(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["status"] = "RELEASE_VALIDATED"
        candidate = manifest["releaseCandidate"]
        candidate["status"] = "PENDING_U6_STABLE_CANDIDATE"
        candidate["sourceRevision"] = None
        candidate["packageManifestSha256"] = None
        candidate["automatedReceipt"] = None
        candidate["manualReceipt"] = None
        with self.assertRaisesRegex(
            MODULE.AudioSidebarValidationError,
            "pending candidate must not claim release PASS",
        ):
            self._validate_manifest(manifest)

    def test_historical_artifact_requires_explicit_classification(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["historicalArtifacts"][0]["classification"] = "CURRENT"
        with self.assertRaisesRegex(MODULE.AudioSidebarValidationError, "not classified"):
            self._validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
