from __future__ import annotations

import copy
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

    def test_historical_artifact_requires_explicit_classification(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["historicalArtifacts"][0]["classification"] = "CURRENT"
        with self.assertRaisesRegex(MODULE.AudioSidebarValidationError, "not classified"):
            self._validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
