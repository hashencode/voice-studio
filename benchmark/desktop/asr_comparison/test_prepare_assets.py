from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from prepare_assets import AssetError, asset_plan, prepare_candidate


ROOT = Path(__file__).resolve().parent


class PrepareAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = json.loads((ROOT / "candidates.json").read_text())
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.output = self.root / "active"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_plan_preserves_exact_first_round_without_downloading(self) -> None:
        plan = asset_plan(self.registry)
        self.assertEqual(len(plan["candidates"]), 7)
        self.assertEqual(
            {item["candidateId"] for item in plan["candidates"]},
            set(self.registry["frozenCandidateSet"]),
        )
        statuses = {
            item["candidateId"]: item["status"] for item in plan["candidates"]
        }
        self.assertEqual(
            statuses["sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"],
            "REJECTED_LICENSE",
        )
        self.assertEqual(
            statuses["sherpa-onnx-funasr-nano-int8-2025-12-30"],
            "REJECTED_LICENSE",
        )
        self.assertEqual(
            statuses["native-funasr-1.3.22-paraformer-vad-punctuation"],
            "CROSS_RUNTIME_CONTROL_COMPLETE",
        )

    def test_prepares_hash_pinned_local_components_atomically(self) -> None:
        candidate = self._fake_candidate()
        source = self.sources / candidate["candidateId"]
        source.mkdir(parents=True)
        (source / "model").write_bytes(b"model")
        (source / "tokens").write_bytes(b"tokens")

        result = prepare_candidate(candidate, self.sources, self.output)

        self.assertEqual(result["candidateId"], candidate["candidateId"])
        self.assertEqual(result["fileCount"], 2)
        self.assertEqual(
            result,
            prepare_candidate(candidate, self.sources, self.output),
        )
        self.assertTrue((self.output / "files" / "model").is_file())

    def test_rejects_pending_hashes_before_copy(self) -> None:
        candidate = copy.deepcopy(self.registry["candidates"][1])
        candidate["license"]["disposition"] = "ACCEPTED_FOR_BENCHMARK"
        candidate["artifacts"][0]["sha256"] = None
        candidate["artifacts"][0]["hashState"] = "PENDING_PROVISIONING"
        with self.assertRaisesRegex(AssetError, "hash-pinned"):
            prepare_candidate(candidate, self.sources, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_unaccepted_license_before_copy(self) -> None:
        candidate = self._fake_candidate()
        candidate["license"]["disposition"] = "REVIEW_REQUIRED"
        with self.assertRaisesRegex(AssetError, "license"):
            prepare_candidate(candidate, self.sources, self.output)
        self.assertFalse(self.output.exists())

    def test_hash_drift_leaves_no_active_partial_tree(self) -> None:
        candidate = self._fake_candidate()
        source = self.sources / candidate["candidateId"]
        source.mkdir(parents=True)
        (source / "model").write_bytes(b"drift")
        (source / "tokens").write_bytes(b"tokens")
        with self.assertRaisesRegex(AssetError, "hash mismatch"):
            prepare_candidate(candidate, self.sources, self.output)
        self.assertFalse(self.output.exists())

    def _fake_candidate(self) -> dict:
        def artifact(component: str, payload: bytes) -> dict:
            return {
                "componentId": component,
                "fileRole": component,
                "sourceUrl": f"https://example.invalid/{component}",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "hashState": "PINNED",
            }

        return {
            "candidateId": "sherpa-test-candidate-2026-07-26",
            "license": {
                "spdx": "Apache-2.0",
                "disposition": "ACCEPTED_FOR_BENCHMARK",
                "noticeSource": "fixture",
            },
            "artifacts": [
                artifact("model", b"model"),
                artifact("tokens", b"tokens"),
            ],
        }


if __name__ == "__main__":
    unittest.main()
