#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "tool" / "validate_s2_mobile_core_scope.py"
MANIFEST_PATH = ROOT / "docs" / "product" / "s2-mobile-core-scope.json"


def _load_validator():
    spec = importlib.util.spec_from_file_location(
        "validate_s2_mobile_core_scope",
        VALIDATOR_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import validator: {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class S2MobileCoreScopeValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = _load_validator()
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def _write_fixture(
        self,
        root: Path,
        manifest: dict,
        *,
        omit_marker_for: str | None = None,
        omit_prd_item: str | None = None,
    ) -> Path:
        for document in manifest["authoritativeDocuments"]:
            path = root / document["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            markers = list(document["requiredMarkers"])
            if document["path"] == omit_marker_for:
                markers = markers[1:]
            lines = markers
            if document["path"].endswith(
                "meeting-voice-recognition-prd-v1.0.md"
            ):
                lines = list(markers)
                for item in manifest["items"]:
                    if item["id"] == omit_prd_item:
                        continue
                    status_markers = []
                    if item["mobileCoreStatus"] == "BLOCKED":
                        status_markers.append("BLOCKED")
                    if item["deferredParts"]:
                        status_markers.append("DEFERRED_NOT_PASSED")
                    lines.append(
                        f"| {item['id']} | fixture | fixture | fixture | "
                        f"{' '.join(status_markers)} |"
                    )
            path.write_text("\n".join(lines), encoding="utf-8")

        manifest_path = root / "docs/product/s2-mobile-core-scope.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return manifest_path

    def _validate_fixture(self, manifest: dict, **kwargs) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = self._write_fixture(root, manifest, **kwargs)
            self.validator.validate_scope_contract(manifest_path, root)

    def test_valid_blocked_baseline_passes(self) -> None:
        self._validate_fixture(copy.deepcopy(self.manifest))

    def test_deferred_item_cannot_be_reported_as_pass(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        item = next(
            item for item in manifest["items"] if item["id"] == "ASR-007"
        )
        item["mobileCoreStatus"] = "PASS"

        with self.assertRaisesRegex(ValueError, "deferred.*NOT_APPLICABLE"):
            self._validate_fixture(manifest)

    def test_approved_split_item_cannot_drop_its_deferred_scope(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        item = next(
            item for item in manifest["items"] if item["id"] == "ASR-006"
        )
        item["disposition"] = "mandatory"
        item["deferredParts"] = []

        with self.assertRaisesRegex(
            ValueError,
            "approved disposition/deferred targets changed",
        ):
            self._validate_fixture(manifest)

    def test_mobile_core_cannot_pass_while_asr_005_is_blocked(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["mobileCore"]["status"] = "PASS"
        manifest["mobileCore"]["remainingBlockers"] = []

        with self.assertRaisesRegex(
            ValueError,
            "remainingBlockers|derived Mobile Core status",
        ):
            self._validate_fixture(manifest)

    def test_timestamp_review_skip_cannot_be_misreported_as_pass(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["timestampGate"]["executionDisposition"] = "PASS"

        with self.assertRaisesRegex(
            ValueError,
            "execution must remain skipped pending user testing",
        ):
            self._validate_fixture(manifest)

    def test_current_baseline_cannot_add_a_second_blocked_gate(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        item = next(
            item for item in manifest["items"] if item["id"] == "TIM-001"
        )
        item["mobileCoreStatus"] = "BLOCKED"
        manifest["mobileCore"]["remainingBlockers"].append(
            item["mandatoryGateId"]
        )
        manifest["mobileCore"]["passCount"] = 16

        with self.assertRaisesRegex(ValueError, "only ASR-005 blocked"):
            self._validate_fixture(manifest)

    def test_declared_gate_counts_must_match_derived_counts(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["mobileCore"]["gateCount"] = 17

        with self.assertRaisesRegex(ValueError, "gateCount"):
            self._validate_fixture(manifest)

    def test_original_s2_item_cannot_disappear(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["items"] = [
            item for item in manifest["items"] if item["id"] != "REC-009"
        ]
        manifest["originalS2BaselineIds"].remove("REC-009")

        with self.assertRaisesRegex(ValueError, "originalS2BaselineIds"):
            self._validate_fixture(manifest)

    def test_authoritative_document_requires_decision_marker(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        path = manifest["authoritativeDocuments"][0]["path"]

        with self.assertRaisesRegex(ValueError, "missing required marker"):
            self._validate_fixture(manifest, omit_marker_for=path)

    def test_authority_marker_contract_cannot_be_weakened(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        document = manifest["authoritativeDocuments"][0]
        document["requiredMarkers"].remove("NOT RELEASE-READY")

        with self.assertRaisesRegex(
            ValueError,
            "requiredMarkers must match the approved authority contract",
        ):
            self._validate_fixture(manifest)

    def test_authoritative_document_cannot_be_removed(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["authoritativeDocuments"] = manifest[
            "authoritativeDocuments"
        ][1:]

        with self.assertRaisesRegex(ValueError, "approved authority set"):
            self._validate_fixture(manifest)

    def test_prd_cannot_drop_an_original_s2_item(self) -> None:
        manifest = copy.deepcopy(self.manifest)

        with self.assertRaisesRegex(ValueError, "PRD is missing original S2 item"):
            self._validate_fixture(manifest, omit_prd_item="POST-005")


if __name__ == "__main__":
    unittest.main()
