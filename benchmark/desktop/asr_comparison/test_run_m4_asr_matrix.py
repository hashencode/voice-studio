from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from run_m4_asr_matrix import (
    LANGUAGE_CANDIDATES,
    _job_model_files,
    language_candidates,
    load_registries,
    profile_for,
    resolve_candidate,
    worker_artifacts,
)


ROOT = Path(__file__).resolve().parent


class RunM4AsrMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.base, cls.expansion = load_registries(ROOT)

    def test_job_model_files_add_onnx_aliases_without_copying_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model"
            model.write_bytes(b"onnx")
            tokens = root / "tokens"
            tokens.write_text("a 0\n")
            tokenizer = root / "tokenizer"
            tokenizer.mkdir()
            aliases = _job_model_files(
                {
                    "model": {"path": str(model), "sha256": "a" * 64},
                    "tokens": {"path": str(tokens), "sha256": "b" * 64},
                    "tokenizer": {"path": str(tokenizer), "sha256": "c" * 64},
                },
                job_root=root / "job",
            )
            model_alias = Path(aliases["model"]["path"])
            self.assertTrue(model_alias.is_symlink())
            self.assertEqual(model_alias.suffix, ".onnx")
            self.assertEqual(model_alias.resolve(), model.resolve())
            self.assertEqual(aliases["tokens"]["path"], str(tokens))
            self.assertEqual(aliases["tokenizer"]["path"], str(tokenizer))

    def test_frozen_language_lanes_are_independent(self) -> None:
        self.assertIn(
            "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            LANGUAGE_CANDIDATES["zh"],
        )
        self.assertIn(
            "sherpa-onnx-streaming-zipformer-en-20m-2023-02-17",
            LANGUAGE_CANDIDATES["en"],
        )
        self.assertNotIn(
            "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            LANGUAGE_CANDIDATES["en"],
        )

    def test_requested_candidate_must_remain_in_frozen_lane(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "outside"):
            language_candidates("en", ("unregistered-model",))

    def test_resolves_base_new_and_override_artifact_shapes(self) -> None:
        baseline = resolve_candidate(
            "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            base=self.base,
            expansion=self.expansion,
        )
        sense_voice = resolve_candidate(
            "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
            base=self.base,
            expansion=self.expansion,
        )
        nano = resolve_candidate(
            "sherpa-onnx-funasr-nano-int8-2025-12-30",
            base=self.base,
            expansion=self.expansion,
        )
        self.assertEqual(
            set(worker_artifacts(baseline)),
            {"encoder", "decoder", "joiner", "tokens"},
        )
        self.assertEqual(set(worker_artifacts(sense_voice)), {"model", "tokens"})
        self.assertEqual(
            set(worker_artifacts(nano)),
            {"encoderAdaptor", "llm", "embedding", "tokenizer"},
        )

    def test_fixed_profiles_freeze_two_threads_and_15_second_segments(self) -> None:
        baseline = resolve_candidate(
            "sherpa-streaming-zipformer-zh-14m-2023-02-23",
            base=self.base,
            expansion=self.expansion,
        )
        profile = profile_for(
            baseline, language_lane="zh", profile_id="fixed-resource"
        )
        self.assertEqual(profile["numThreads"], 2)
        self.assertEqual(profile["concurrency"], 1)
        self.assertEqual(profile["segmentDurationSeconds"], 15)


if __name__ == "__main__":
    unittest.main()
