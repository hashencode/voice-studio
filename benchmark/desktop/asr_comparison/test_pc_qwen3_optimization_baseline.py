from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BASELINE_PATH = ROOT / "pc_qwen3_optimization_baseline.json"
PRODUCT_MANIFEST_PATH = (
    ROOT.parents[2]
    / "apps"
    / "desktop"
    / "assets"
    / "processing"
    / "frozen_sherpa_macos_arm64.json"
)


def _baseline() -> dict[str, object]:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


class PcQwen3OptimizationBaselineTest(unittest.TestCase):
    def test_product_profile_is_the_single_frozen_qwen3_profile(self) -> None:
        product = _baseline()["product"]
        self.assertIsInstance(product, dict)
        assert isinstance(product, dict)
        self.assertEqual(
            product["asrCandidateId"],
            "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        )
        self.assertEqual(product["asrCandidateCount"], 1)
        self.assertIs(product["diarizationIsIndependent"], True)
        self.assertEqual(
            product["profile"],
            {
                "provider": "cpu",
                "numThreads": 2,
                "concurrency": 1,
                "modelPrecision": "int8",
                "segmentDurationSeconds": 15,
                "maxTotalLen": 512,
                "maxNewTokens": 512,
                "temperature": 0.000001,
                "topP": 0.8,
                "seed": 42,
                "hotwords": "",
                "segmentation": "official_silero_vad",
                "vadThreshold": 0.2,
                "minimumSpeechSeconds": 0.2,
                "maximumSpeechSeconds": 12,
            },
        )

    def test_product_model_hashes_match_the_shipping_manifest(self) -> None:
        baseline = _baseline()
        product = baseline["product"]
        optimization = baseline["optimizationCandidate"]
        license_state = baseline["license"]
        assert isinstance(product, dict)
        assert isinstance(optimization, dict)
        assert isinstance(license_state, dict)
        self.assertIs(optimization["productEligible"], True)
        self.assertEqual(optimization["status"], "OPTIMIZATION_ADMITTED")
        self.assertEqual(optimization["selectedArm"], "vad-max-speech-12")
        self.assertIs(license_state["distributionEligible"], False)

        manifest = json.loads(PRODUCT_MANIFEST_PATH.read_text(encoding="utf-8"))
        downloads = {item["id"]: item for item in manifest["downloads"]}
        files = {item["relativePath"]: item for item in manifest["files"]}
        hashes = product["modelHashes"]
        assert isinstance(hashes, dict)
        self.assertEqual(
            hashes["archive"],
            downloads["qwen3-asr-archive"]["sha256"],
        )
        for baseline_key, relative_path in (
            ("convFrontend", "asr/conv_frontend.onnx"),
            ("encoder", "asr/encoder.int8.onnx"),
            ("decoder", "asr/decoder.int8.onnx"),
            ("sileroVad", "asr/silero_vad.onnx"),
        ):
            self.assertEqual(hashes[baseline_key], files[relative_path]["sha256"])

    def test_evidence_hashes_bind_existing_aggregate_reports(self) -> None:
        evidence = _baseline()["evidence"]
        self.assertIsInstance(evidence, list)
        assert isinstance(evidence, list)
        for item in evidence:
            self.assertIsInstance(item, dict)
            assert isinstance(item, dict)
            path = ROOT / item["path"]
            self.assertTrue(path.is_file())
            self.assertEqual(
                hashlib.sha256(path.read_bytes()).hexdigest(),
                item["sha256"],
            )

    def test_public_baseline_contains_no_local_paths_or_raw_transcripts(
        self,
    ) -> None:
        baseline = _baseline()
        privacy = baseline["privacy"]
        self.assertIsInstance(privacy, dict)
        self.assertEqual(
            privacy,
            {
                "audioPublished": False,
                "modelFilesPublished": False,
                "transcriptsPublished": False,
                "absolutePathsPublished": False,
                "credentialsPublished": False,
            },
        )
        serialized = BASELINE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("/Users/", serialized)
        self.assertNotIn("\\Users\\", serialized)


if __name__ == "__main__":
    unittest.main()
