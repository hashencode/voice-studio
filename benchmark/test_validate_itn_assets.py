from __future__ import annotations

import copy
import json
import unittest

from benchmark.validate_itn_assets import (
    DEFAULT_MANIFEST,
    ItnValidationError,
    validate_manifest,
)


class ValidateItnAssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))

    def test_repository_manifest_is_explicitly_fail_closed(self) -> None:
        self.assertFalse(validate_manifest(self.manifest))

    def test_verified_gate_requires_an_asset(self) -> None:
        payload = copy.deepcopy(self.manifest)
        payload["productGate"] = {
            "available": True,
            "verified": True,
            "reason": None,
        }
        with self.assertRaisesRegex(ItnValidationError, "requires an asset"):
            validate_manifest(payload)

    def test_golden_fixture_hash_is_pinned(self) -> None:
        payload = copy.deepcopy(self.manifest)
        payload["goldenFixture"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ItnValidationError, "hash mismatch"):
            validate_manifest(payload)

    def test_disabled_gate_rejects_an_unverified_asset(self) -> None:
        payload = copy.deepcopy(self.manifest)
        payload["asset"] = {"path": "untrusted.fst"}
        with self.assertRaisesRegex(ItnValidationError, "must not retain"):
            validate_manifest(payload)


if __name__ == "__main__":
    unittest.main()
