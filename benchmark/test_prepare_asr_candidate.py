from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmark.prepare_asr_candidate import download, safe_relative_path


class PrepareAsrCandidateTest(unittest.TestCase):
    def test_accepts_nested_required_file(self) -> None:
        self.assertEqual(
            safe_relative_path("model/encoder.onnx", label="required file").as_posix(),
            "model/encoder.onnx",
        )

    def test_rejects_parent_traversal(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe required file"):
            safe_relative_path("../outside", label="required file")

    def test_rejects_absolute_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe required file"):
            safe_relative_path("/tmp/outside", label="required file")

    def test_rejects_nested_archive_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe archive name"):
            safe_relative_path(
                "nested/archive.tar.bz2",
                label="archive name",
                single_component=True,
            )

    def test_failed_download_removes_partial_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "candidate.partial"
            destination.write_bytes(b"stale")
            with (
                patch(
                    "benchmark.prepare_asr_candidate.urllib.request.urlopen",
                    side_effect=TimeoutError("timed out"),
                ),
                self.assertRaisesRegex(TimeoutError, "timed out"),
            ):
                download("https://example.invalid/model.tar.bz2", destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
