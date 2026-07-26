from __future__ import annotations

import copy
import hashlib
import io
import json
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from freeze_ranked_fixtures import (
    RankedFixtureFreezeError,
    build_ranked_review_template,
    freeze_ranked_manifest,
)
from prepare_fixtures import sha256_file, validate_manifest


ROOT = Path(__file__).resolve().parent


class FreezeRankedFixturesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads((ROOT / "fixtures.json").read_text())
        self.temporary = tempfile.TemporaryDirectory()
        self.repository_root = Path(self.temporary.name)
        self.output_root = (
            self.repository_root
            / "build/desktop_asr_comparison/fixtures/ranked-freeze"
        )
        self._write_local_sources()
        self.review = self._completed_review()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_template_covers_complete_ranked_set_without_private_paths(
        self,
    ) -> None:
        template = build_ranked_review_template(self.manifest)

        self.assertEqual(template["kind"], "ranked_fixture_review")
        self.assertEqual(len(template["fixtures"]), 12)
        self.assertEqual(
            {
                entry["fixtureRole"]
                for entry in template["fixtures"]
            },
            {"development", "held_out", "long_7200s"},
        )
        self.assertTrue(
            all(
                entry["roleAssignmentConfirmed"] is False
                for entry in template["fixtures"]
            )
        )
        encoded = json.dumps(template)
        self.assertNotIn("relativePath", encoded)
        self.assertNotIn(str(self.repository_root), encoded)

    def test_freezes_complete_ranked_manifest_without_payloads(self) -> None:
        result = freeze_ranked_manifest(
            self.manifest,
            self.review,
            repository_root=self.repository_root,
            output_root=self.output_root,
            audio_inspector=self._ranked_audio_inspector,
        )

        frozen_path = self.output_root / "fixtures.json"
        freeze_path = self.output_root / "ranked-fixture-freeze.json"
        frozen = json.loads(frozen_path.read_text())
        evidence = json.loads(freeze_path.read_text())
        validate_manifest(frozen, ranked=True)
        self.assertEqual(result, evidence)
        self.assertEqual(result["rankedFixtureCount"], 12)
        self.assertEqual(
            result["roleCounts"],
            {
                "development": 4,
                "held_out": 7,
                "long_7200s": 1,
            },
        )
        self.assertEqual(
            result["frozenFixtureManifestSha256"],
            sha256_file(frozen_path),
        )
        self.assertTrue(
            frozen["fixtureManifestId"].startswith(
                "desktop-processing/macos-asr-fixtures-v2-ranked-"
            )
        )
        self.assertEqual(
            {path.name for path in self.output_root.iterdir()},
            {"fixtures.json", "ranked-fixture-freeze.json"},
        )
        published = json.dumps(evidence, ensure_ascii=False)
        self.assertNotIn("测试参考", published)
        self.assertNotIn(str(self.repository_root), published)
        self.assertFalse(
            any(
                path.suffix == ".wav"
                for path in self.output_root.rglob("*")
            )
        )

    def test_rejects_unsealed_held_out_content_before_writing(self) -> None:
        review = copy.deepcopy(self.review)
        held_out = next(
            entry
            for entry in review["fixtures"]
            if entry["fixtureRole"] == "held_out"
        )
        held_out["heldOutContentDisposition"] = "PENDING"

        with self.assertRaisesRegex(
            RankedFixtureFreezeError,
            "held-out content is not sealed",
        ):
            freeze_ranked_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
                audio_inspector=self._ranked_audio_inspector,
            )

        self.assertFalse(self.output_root.exists())

    def test_local_meeting_requires_signed_consent_review(self) -> None:
        review = copy.deepcopy(self.review)
        meeting = next(
            entry
            for entry in review["fixtures"]
            if entry["sourceKind"] == "consented_local_meeting"
        )
        meeting["licenseOrConsent"] = "REVIEWED_FOR_LOCAL_BENCHMARK"

        with self.assertRaisesRegex(
            RankedFixtureFreezeError,
            "signed consent review is required",
        ):
            freeze_ranked_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
                audio_inspector=self._ranked_audio_inspector,
            )

    def test_real_audio_inspection_rejects_short_finalist_fixture(self) -> None:
        with self.assertRaisesRegex(
            RankedFixtureFreezeError,
            "7,200-second",
        ):
            freeze_ranked_manifest(
                self.manifest,
                self.review,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

        self.assertFalse(self.output_root.exists())

    def test_rejects_stale_or_private_review_receipt(self) -> None:
        stale = copy.deepcopy(self.review)
        stale["fixtureManifestId"] = "stale"
        with self.assertRaisesRegex(
            RankedFixtureFreezeError,
            "fixture manifest identity mismatch",
        ):
            freeze_ranked_manifest(
                self.manifest,
                stale,
                repository_root=self.repository_root,
                output_root=self.output_root,
                audio_inspector=self._ranked_audio_inspector,
            )

        private = copy.deepcopy(self.review)
        private["speakerName"] = "private"
        with self.assertRaisesRegex(
            RankedFixtureFreezeError,
            "review receipt fields mismatch",
        ):
            freeze_ranked_manifest(
                self.manifest,
                private,
                repository_root=self.repository_root,
                output_root=self.output_root,
                audio_inspector=self._ranked_audio_inspector,
            )

    def _completed_review(self) -> dict:
        template = build_ranked_review_template(self.manifest)
        consented = {
            "consented_internal_recording",
            "reviewed_local_meeting",
            "consented_local_meeting",
        }
        for entry in template["fixtures"]:
            fixture_id = entry["fixtureId"]
            entry["sourceProvenanceRecordSha256"] = hashlib.sha256(
                f"{fixture_id}:provenance".encode()
            ).hexdigest()
            entry["sourceProvenanceRecordDate"] = "2026-07-26"
            entry["licenseOrConsent"] = (
                "SIGNED_CONSENT_REVIEWED_FOR_LOCAL_BENCHMARK"
                if entry["sourceKind"] in consented
                else "REVIEWED_FOR_LOCAL_BENCHMARK"
            )
            entry["licenseOrConsentRecordSha256"] = hashlib.sha256(
                f"{fixture_id}:license".encode()
            ).hexdigest()
            entry["licenseOrConsentRecordDate"] = "2026-07-26"
            entry["referenceReview"] = "REVIEWED"
            entry["referenceReviewRecordSha256"] = hashlib.sha256(
                f"{fixture_id}:reference".encode()
            ).hexdigest()
            if entry["scenario"] == "dialect_accent":
                entry["varietyReview"] = "REVIEWED"
                entry["varietyReviewRecordSha256"] = hashlib.sha256(
                    f"{fixture_id}:variety".encode()
                ).hexdigest()
            entry["roleAssignmentConfirmed"] = True
            entry["speakerSessionDisjointnessConfirmed"] = True
            entry["heldOutContentDisposition"] = (
                "SEALED_FROM_BENCHMARK_OPERATOR"
                if entry["fixtureRole"] in {"held_out", "long_7200s"}
                else "NOT_APPLICABLE"
            )
            entry["redistributionConfirmed"] = "never_commit"
            entry["localOnlyConfirmed"] = True
        return template

    def _write_local_sources(self) -> None:
        for fixture in self._ranked_fixtures():
            audio = self._local_path(fixture["audio"]["relativePath"])
            reference = self._local_path(
                fixture["reference"]["relativePath"]
            )
            audio.parent.mkdir(parents=True, exist_ok=True)
            reference.parent.mkdir(parents=True, exist_ok=True)
            audio.write_bytes(self._wav_bytes())
            reference.write_text(
                "" if fixture["scenario"] == "non_speech" else "测试参考",
                encoding="utf-8",
            )

    def _ranked_audio_inspector(
        self,
        path: Path,
        fixture_id: str,
    ) -> dict:
        payload = path.read_bytes()
        return {
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "durationSeconds": (
                7200.0
                if fixture_id == "finalist-local-meeting-7200s"
                else 1.0
            ),
            "sampleRateHz": 16000,
            "channels": 1,
            "sampleWidthBytes": 2,
        }

    def _ranked_fixtures(self) -> list[dict]:
        return [
            fixture
            for fixture in self.manifest["fixtures"]
            if fixture["fixtureRole"]
            in {"development", "held_out", "long_7200s"}
        ]

    def _local_path(self, relative: str) -> Path:
        local_root = (
            self.repository_root
            / self.manifest["privacyPolicy"]["localOnlyRoot"]
        )
        relative_path = Path(relative)
        return local_root / Path(*relative_path.parts[1:])

    @staticmethod
    def _wav_bytes() -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(16000)
            target.writeframes(struct.pack("<16000h", *([0] * 16000)))
        return output.getvalue()


if __name__ == "__main__":
    unittest.main()
