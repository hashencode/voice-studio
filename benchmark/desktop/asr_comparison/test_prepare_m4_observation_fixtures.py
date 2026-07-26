from __future__ import annotations

import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace

from prepare_m4_fleurs_fixtures import sha256_file
from prepare_m4_observation_fixtures import (
    ObservationFixtureError,
    _operational_fixture,
    _select_streaming_row,
)


class M4ObservationFixtureTest(unittest.TestCase):
    def test_streaming_row_offset_is_bounded(self) -> None:
        rows = [
            SimpleNamespace(duration_seconds=2.0, identity="too-short"),
            SimpleNamespace(duration_seconds=9.0, identity="first"),
            SimpleNamespace(duration_seconds=12.0, identity="second"),
            SimpleNamespace(duration_seconds=21.0, identity="too-long"),
        ]
        self.assertEqual(_select_streaming_row(rows, 1).identity, "second")
        with self.assertRaises(ObservationFixtureError):
            _select_streaming_row(rows, 2)

    def test_operational_fixture_concatenates_ten_distinct_scenarios(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            validation = root / "validation"
            held_out = root / "held_out"
            output = root / "output"
            self._fixture_pack(validation, "zh", "development")
            self._fixture_pack(held_out, "zh", "held_out")
            fixture, scenarios = _operational_fixture(
                language_lane="zh",
                validation_root=validation,
                held_out_root=held_out,
                output_root=output,
            )
            self.assertEqual(fixture["sourceFixtureCount"], 10)
            self.assertEqual(len(scenarios), 10)
            self.assertGreater(fixture["durationSeconds"], 10)
            self.assertTrue((output / fixture["audioRelativePath"]).is_file())

    @staticmethod
    def _fixture_pack(root: Path, language_lane: str, role: str) -> None:
        root.mkdir(parents=True)
        fixtures = []
        for index in range(5):
            audio = root / f"{role}-{index}.wav"
            reference = root / f"{role}-{index}.txt"
            with wave.open(str(audio), "wb") as destination:
                destination.setnchannels(1)
                destination.setsampwidth(2)
                destination.setframerate(16000)
                destination.writeframes(b"\0\0" * 1600)
            reference.write_text(f"fixture {role} {index}\n", encoding="utf-8")
            fixtures.append(
                {
                    "fixtureId": f"{role}-{index}",
                    "fixtureRole": role,
                    "scenario": f"scenario-{index}",
                    "audioRelativePath": audio.name,
                    "audioSha256": sha256_file(audio),
                    "referenceRelativePath": reference.name,
                    "referenceSha256": sha256_file(reference),
                }
            )
        (root / "manifest.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "languageLane": language_lane,
                    "fixtures": fixtures,
                }
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
