from __future__ import annotations

import json
import unittest
from pathlib import Path

from run_expanded_stage0 import _candidate, _capabilities


ROOT = Path(__file__).resolve().parent


class ExpandedStage0Test(unittest.TestCase):
    def setUp(self) -> None:
        self.expansion = json.loads(
            (ROOT / "expanded_candidates_m4.json").read_text()
        )
        self.base = json.loads((ROOT / "candidates.json").read_text())

    def test_resolves_new_and_overridden_candidates(self) -> None:
        new = _candidate(
            "sherpa-onnx-whisper-base-en-int8-2023-01-31",
            self.expansion,
            self.base,
        )
        override = _candidate(
            "sherpa-onnx-funasr-nano-int8-2025-12-30",
            self.expansion,
            self.base,
        )

        self.assertEqual(new["family"], "offline_whisper")
        self.assertEqual(override["family"], "funasr_nano")
        self.assertEqual(set(override["languageLanes"]), {"zh", "en"})

    def test_capabilities_remain_family_specific(self) -> None:
        streaming = _capabilities("streaming_zipformer_transducer")
        nano = _capabilities("funasr_nano")
        whisper = _capabilities("offline_whisper")

        self.assertTrue(streaming["streaming"])
        self.assertTrue(streaming["partialResults"])
        self.assertTrue(nano["seededGeneration"])
        self.assertFalse(whisper["streaming"])
        self.assertFalse(whisper["seededGeneration"])


if __name__ == "__main__":
    unittest.main()
