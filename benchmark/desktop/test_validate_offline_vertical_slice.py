import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from validate_offline_vertical_slice import validate


class OfflineVerticalSliceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.export = self.root / "meeting.vtt"
        self.export.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nok\n")
        self.evidence = self.root / "evidence.json"
        self.payload = {
            "schemaVersion": 1,
            "source": "local_private_file",
            "cloudProvidersInvoked": [],
            "aiFeaturesInvoked": [],
            "reviewState": "manual_correction_available",
            "reviewRevisionCount": 0,
            "exportFormat": "webvtt",
            "exportSha256": hashlib.sha256(self.export.read_bytes()).hexdigest(),
            "complete": True,
            "segmentCount": 1,
            "speakerAssignments": ["anonymous", "overlap", "unknown"],
        }
        self._write()

    def tearDown(self):
        self.temporary.cleanup()

    def _write(self):
        self.evidence.write_text(json.dumps(self.payload))

    def test_accepts_offline_review_and_export_slice(self):
        validate(self.evidence, self.export)

    def test_rejects_cloud_or_ai_use(self):
        self.payload["cloudProvidersInvoked"] = ["remote"]
        self._write()
        with self.assertRaises(ValueError):
            validate(self.evidence, self.export)

    def test_rejects_non_anonymous_speaker_identity(self):
        self.payload["speakerAssignments"] = ["alice"]
        self._write()
        with self.assertRaises(ValueError):
            validate(self.evidence, self.export)


if __name__ == "__main__":
    unittest.main()
