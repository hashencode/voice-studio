from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name(
    "validate_audio_activity_boundary.py"
)
SPEC = importlib.util.spec_from_file_location(
    "validate_audio_activity_boundary",
    MODULE_PATH,
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AudioActivityBoundaryTest(unittest.TestCase):
    def test_repository_inventory_and_authorities_are_complete(self) -> None:
        MODULE.validate()

    def test_unclassified_meeting_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            rogue = root / "src" / "rogue.dart"
            rogue.parent.mkdir(parents=True)
            rogue.write_text("class MeetingLeak {}\n", encoding="utf-8")

            self.assertEqual(
                MODULE.find_unclassified_meeting_paths(
                    root,
                    active=[],
                    historical=[],
                    rejection=[],
                ),
                ["src/rogue.dart"],
            )

    def test_explicit_historical_prefix_is_the_only_exemption(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            historical = root / "docs" / "plans" / "done.md"
            historical.parent.mkdir(parents=True)
            historical.write_text("Completed Meeting plan.\n", encoding="utf-8")

            self.assertEqual(
                MODULE.find_unclassified_meeting_paths(
                    root,
                    active=[],
                    historical=["docs/plans"],
                    rejection=[],
                ),
                [],
            )


if __name__ == "__main__":
    unittest.main()
