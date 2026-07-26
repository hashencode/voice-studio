from __future__ import annotations

import unittest

from prepare_m4_fleurs_fixtures import (
    SourceRow,
    far_field_noise_pcm,
    select_duration,
    terminology_priority,
)


def row(row_id: int, seconds: float, text: str = "sample") -> SourceRow:
    return SourceRow(
        row_id=row_id,
        num_samples=round(seconds * 16_000),
        audio_bytes=b"RIFF",
        transcription=text,
        gender=row_id % 2,
    )


class PrepareM4FleursFixturesTest(unittest.TestCase):
    def test_duration_selection_is_stable_and_keeps_remainder(self) -> None:
        selected, remaining = select_duration(
            [row(1, 1.5), row(2, 1.5), row(3, 1.5)],
            2.5,
        )
        self.assertEqual([value.row_id for value in selected], [1, 2])
        self.assertEqual([value.row_id for value in remaining], [3])

    def test_insufficient_duration_fails_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "provide only"):
            select_duration([row(1, 1.0)], 2.0)

    def test_terminology_priority_prefers_numbers_and_named_terms(self) -> None:
        plain = row(1, 1.0, "ordinary sample")
        marked = row(2, 1.0, "OpenAI released 2026 Model")
        self.assertGreater(
            terminology_priority(marked, "en"),
            terminology_priority(plain, "en"),
        )

    def test_far_field_transform_is_deterministic_and_non_identity(self) -> None:
        pcm = (b"\x10\x00" * 2000)
        first = far_field_noise_pcm(pcm, seed=7, delay_samples=10)
        second = far_field_noise_pcm(pcm, seed=7, delay_samples=10)
        self.assertEqual(first, second)
        self.assertNotEqual(first, pcm)
        self.assertEqual(len(first), len(pcm))


if __name__ == "__main__":
    unittest.main()
