from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from validate_m4_development_freeze import FreezeError, validate


ROOT = Path(__file__).resolve().parent


class M4DevelopmentFreezeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = json.loads(
            (ROOT / "m4_development_freeze.json").read_text(encoding="utf-8")
        )

    def test_accepts_frozen_document(self) -> None:
        validate(copy.deepcopy(self.document))

    def test_rejects_profile_or_finalist_drift(self) -> None:
        profile_drift = copy.deepcopy(self.document)
        profile_drift["resourceProfile"]["numThreads"] = 4
        with self.assertRaisesRegex(FreezeError, "profile drifted"):
            validate(profile_drift)
        finalist_drift = copy.deepcopy(self.document)
        finalist_drift["languageLanes"]["en"]["finalistCandidateIds"].append(
            "extra-candidate"
        )
        with self.assertRaisesRegex(FreezeError, "exactly two"):
            validate(finalist_drift)

    def test_rejects_private_paths(self) -> None:
        document = copy.deepcopy(self.document)
        document["note"] = "/Users/private/audio.wav"
        with self.assertRaisesRegex(FreezeError, "absolute user path"):
            validate(document)


if __name__ == "__main__":
    unittest.main()
