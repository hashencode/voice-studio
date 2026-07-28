from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qwen3_optimization_driver import (
    DEFAULT_CONTRACT,
    DriverError,
    bounded_hotwords,
    build_profiles,
    resolve_fixtures,
)


class Qwen3OptimizationDriverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(DEFAULT_CONTRACT.read_text(encoding="utf-8"))

    def test_vad_sweep_changes_one_variable_from_its_registered_base(self) -> None:
        profiles = {
            profile["id"]: profile
            for profile in build_profiles(self.contract, "Qwen 会议")
        }
        control = profiles["control"]["config"]
        official = profiles["vad-official-20"]["config"]
        twelve = profiles["vad-max-speech-12"]["config"]

        self.assertEqual(
            {
                key
                for key in control
                if control.get(key) != official.get(key)
            },
            {"segmentation"},
        )
        self.assertEqual(
            {
                key
                for key in official
                if official.get(key) != twelve.get(key)
            },
            {"maxSpeechSeconds"},
        )
        self.assertEqual(
            profiles["vad-max-speech-12"]["baseArmId"],
            "vad-official-20",
        )

    def test_hotword_pack_uses_frozen_annotations_and_deduplicates(self) -> None:
        fixtures = [
            {
                "annotations": {
                    "terminology": [
                        {"expectedAlternatives": ["Qwen", "千问"]},
                        {"expectedAlternatives": ["Qwen"]},
                        {"expectedAlternatives": ["会议工作站"]},
                    ]
                }
            }
        ]
        self.assertEqual(
            bounded_hotwords(fixtures, self.contract),
            "Qwen 会议工作站",
        )

    def test_quality_pack_requires_one_frozen_held_out_fixture_per_scenario(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = []
            for scenario in self.contract["inputs"]["requiredScenarios"]:
                audio = f"{scenario}.wav".encode()
                reference = f"{scenario} reference".encode()
                audio_path = root / f"{scenario}.wav"
                reference_path = root / f"{scenario}.txt"
                audio_path.write_bytes(audio)
                reference_path.write_bytes(reference)
                fixture = {
                    "fixtureId": f"held-out-{scenario}",
                    "fixtureRole": "held_out",
                    "scenario": scenario,
                    "freezeState": "FROZEN",
                    "audio": {
                        "relativePath": audio_path.name,
                        "sha256": hashlib.sha256(audio).hexdigest(),
                    },
                    "reference": {
                        "relativePath": reference_path.name,
                        "sha256": hashlib.sha256(reference).hexdigest(),
                    },
                }
                if scenario == "terminology_numbers":
                    fixture["annotations"] = {
                        "terminology": [
                            {"expectedAlternatives": ["Qwen"]}
                        ]
                    }
                fixtures.append(fixture)
            resolved = resolve_fixtures(
                self.contract,
                {"fixtures": fixtures},
                root,
            )
            self.assertEqual(
                {fixture["scenario"] for fixture in resolved},
                set(self.contract["inputs"]["requiredScenarios"]),
            )

            fixtures[0]["freezeState"] = "PENDING_LOCAL_ASSET"
            with self.assertRaisesRegex(DriverError, "exactly one frozen"):
                resolve_fixtures(
                    self.contract,
                    {"fixtures": fixtures},
                    root,
                )


if __name__ == "__main__":
    unittest.main()
