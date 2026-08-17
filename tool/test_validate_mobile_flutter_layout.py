from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tool.validate_mobile_flutter_layout import DEFAULT_MANIFEST, validate_mobile_layout


class MobileFlutterLayoutTest(unittest.TestCase):
    def test_repository_layout_passes(self) -> None:
        result = validate_mobile_layout()
        self.assertEqual("PASS", result["status"])
        self.assertEqual("apps/mobile-flutter", result["mobileRoot"])
        self.assertEqual(333, result["movedTrackedFileCount"])
        self.assertEqual("DEFERRED_OUT_OF_CURRENT_SCOPE", result["windowsDesktop"])

    def test_manifest_cannot_claim_windows_pass(self) -> None:
        payload = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        payload["platformScope"]["windowsDesktop"] = "PASS"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "platform scope drift"):
                validate_mobile_layout(path)

    def test_identity_hash_drift_is_rejected(self) -> None:
        payload = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        payload["mobileIdentity"]["sherpaAar"]["sha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "sherpaAar hash drift"):
                validate_mobile_layout(path)

    def test_moved_path_inventory_cannot_be_substituted(self) -> None:
        payload = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        payload["movedTrackedPaths"][0] = "apps/mobile-flutter/pubspec.yaml"
        payload["movedTrackedPaths"].sort()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "moved tracked paths drift"):
                validate_mobile_layout(path)

    def test_moved_path_must_still_exist(self) -> None:
        payload = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        source = Path("apps/mobile-flutter/.metadata")
        payload["movedTrackedPaths"][0] = "apps/mobile-flutter/missing-move-fixture"
        payload["movedTrackedPaths"].sort()
        from tool import validate_mobile_flutter_layout as layout

        original = layout.EXPECTED_MOVED_PATHS_SHA256
        layout.EXPECTED_MOVED_PATHS_SHA256 = layout._path_list_sha256(payload["movedTrackedPaths"])
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "layout.json"
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertTrue(source.is_file())
                with self.assertRaisesRegex(ValueError, "moved tracked path missing"):
                    validate_mobile_layout(path)
        finally:
            layout.EXPECTED_MOVED_PATHS_SHA256 = original

    def test_electron_identity_file_set_cannot_be_removed(self) -> None:
        payload = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
        payload["electronIdentity"]["files"] = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Electron identity file set drift"):
                validate_mobile_layout(path)


if __name__ == "__main__":
    unittest.main()
