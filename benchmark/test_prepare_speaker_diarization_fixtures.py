import array
import json
import tempfile
import unittest
import wave
from pathlib import Path

from benchmark.prepare_speaker_diarization_fixtures import (
    prepare_fixtures,
    read_pcm16_mono,
)


class PrepareSpeakerDiarizationFixturesTest(unittest.TestCase):
    def test_generates_deterministic_functional_and_resource_fixtures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources"
            output = root / "output"
            sources.mkdir()
            self._write_tone(sources / "speaker1_a.wav", value=1_000, frames=2_400)
            self._write_tone(sources / "speaker1_b.wav", value=2_000, frames=3_200)
            self._write_tone(sources / "speaker2_a.wav", value=-1_000, frames=2_800)
            manifest = {
                "schemaVersion": 2,
                "contractId": "speaker-test/v2",
                "fixtureSources": [
                    {
                        "id": "speaker1_a",
                        "speaker": "speaker_1",
                        "file": "speaker1_a.wav",
                        "sha256": self._sha256(sources / "speaker1_a.wav"),
                    },
                    {
                        "id": "speaker1_b",
                        "speaker": "speaker_1",
                        "file": "speaker1_b.wav",
                        "sha256": self._sha256(sources / "speaker1_b.wav"),
                    },
                    {
                        "id": "speaker2_a",
                        "speaker": "speaker_2",
                        "file": "speaker2_a.wav",
                        "sha256": self._sha256(sources / "speaker2_a.wav"),
                    },
                ],
            }

            first = prepare_fixtures(
                manifest=manifest,
                source_root=sources,
                output_root=output,
                functional_duration_seconds=3,
                resource_duration_seconds=4,
            )
            first_manifest = json.loads(
                (output / "generated_manifest.json").read_text(encoding="utf-8")
            )
            second = prepare_fixtures(
                manifest=manifest,
                source_root=sources,
                output_root=output,
                functional_duration_seconds=3,
                resource_duration_seconds=4,
            )

            self.assertEqual(first, second)
            self.assertEqual(first, first_manifest)
            functional = read_pcm16_mono(output / "speaker-functional-5m.wav")
            resource = read_pcm16_mono(output / "speaker-resource-120m.wav")
            self.assertEqual(48_000, len(functional))
            self.assertEqual(64_000, len(resource))
            self.assertTrue(first["functional"]["overlapRegions"])
            self.assertTrue(first["functional"]["silenceRegions"])
            self.assertEqual(
                {
                    "activityWithoutAttribution": "UNKNOWN",
                    "noActivity": "SILENCE",
                },
                first["semanticContract"],
            )
            self.assertFalse(Path(first["functional"]["path"]).is_absolute())
            rttm = (output / "speaker-functional-5m.rttm").read_text(encoding="utf-8")
            self.assertIn("speaker_1", rttm)
            self.assertIn("speaker_2", rttm)

    def test_rejects_source_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources"
            sources.mkdir()
            self._write_tone(sources / "speaker1.wav", value=100, frames=1_600)
            manifest = {
                "schemaVersion": 2,
                "contractId": "speaker-test/v2",
                "fixtureSources": [
                    {
                        "id": "speaker1",
                        "speaker": "speaker_1",
                        "file": "speaker1.wav",
                        "sha256": "0" * 64,
                    },
                    {
                        "id": "speaker2",
                        "speaker": "speaker_2",
                        "file": "speaker1.wav",
                        "sha256": self._sha256(sources / "speaker1.wav"),
                    },
                ],
            }

            with self.assertRaisesRegex(ValueError, "SHA-256"):
                prepare_fixtures(
                    manifest=manifest,
                    source_root=sources,
                    output_root=root / "output",
                    functional_duration_seconds=1,
                    resource_duration_seconds=1,
                )

    @staticmethod
    def _write_tone(path: Path, *, value: int, frames: int) -> None:
        samples = array.array("h", [value] * frames)
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16_000)
            output.writeframes(samples.tobytes())

    @staticmethod
    def _sha256(path: Path) -> str:
        import hashlib

        return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
