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

from freeze_development_fixtures import (
    DevelopmentFixtureFreezeError,
    build_review_template,
    freeze_development_manifest,
)
from prepare_fixtures import prepare, sha256_file, validate_manifest


ROOT = Path(__file__).resolve().parent


class FreezeDevelopmentFixturesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads((ROOT / "fixtures.json").read_text())
        self.temporary = tempfile.TemporaryDirectory()
        self.repository_root = Path(self.temporary.name)
        self.output_root = (
            self.repository_root
            / "build/desktop_asr_comparison/fixtures/development-freeze"
        )
        self._write_local_sources()
        self.review = self._completed_review()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_template_is_fail_closed_and_contains_no_source_paths(self) -> None:
        template = build_review_template(self.manifest)

        self.assertEqual(template["kind"], "development_fixture_review")
        self.assertEqual(len(template["fixtures"]), 4)
        self.assertTrue(
            all(not item["developmentRoleConfirmed"] for item in template["fixtures"])
        )
        self.assertNotIn("relativePath", json.dumps(template))
        self.assertNotIn(str(self.repository_root), json.dumps(template))

    def test_freezes_hash_pinned_development_manifest_without_raw_payloads(
        self,
    ) -> None:
        result = freeze_development_manifest(
            self.manifest,
            self.review,
            repository_root=self.repository_root,
            output_root=self.output_root,
        )

        frozen_path = self.output_root / "fixtures.json"
        bindings_path = (
            self.output_root / "development-fixture-freeze.json"
        )
        frozen = json.loads(frozen_path.read_text())
        bindings = json.loads(bindings_path.read_text())
        validate_manifest(frozen, ranked=False, development=True)
        self.assertTrue(
            frozen["fixtureManifestId"].startswith(
                "desktop-processing/macos-asr-fixtures-v2-development-"
            )
        )
        self.assertEqual(
            result["frozenFixtureManifestSha256"],
            sha256_file(frozen_path),
        )
        self.assertEqual(
            bindings["frozenFixtureManifestSha256"],
            sha256_file(frozen_path),
        )
        self.assertTrue(
            all(
                item["sourceProvenanceRecordSha256"]
                and item["sourceProvenanceRecordDate"] == "2026-07-26"
                and item["licenseOrConsentRecordDate"] == "2026-07-26"
                for item in bindings["fixtureBindings"]
            )
        )
        development = [
            fixture
            for fixture in frozen["fixtures"]
            if fixture["fixtureRole"] == "development"
        ]
        self.assertEqual(len(development), 4)
        self.assertTrue(
            all(
                fixture["freezeState"] == "FROZEN"
                and fixture["referenceReview"] == "REVIEWED"
                and fixture["audio"]["durationSeconds"] == 1.0
                and fixture["audio"]["bytes"] == len(self._wav_bytes())
                for fixture in development
            )
        )
        self.assertEqual(
            {path.name for path in self.output_root.iterdir()},
            {"fixtures.json", "development-fixture-freeze.json"},
        )
        published = json.dumps(bindings, ensure_ascii=False)
        self.assertNotIn("测试参考", published)
        self.assertNotIn(str(self.repository_root), published)
        self.assertFalse(
            any(
                path.suffix == ".wav"
                for path in self.output_root.rglob("*")
            )
        )
        prepared = prepare(
            frozen,
            repository_root=self.repository_root,
            output_root=(
                self.repository_root
                / "build/desktop_asr_comparison/fixtures/development-active"
            ),
            ranked=False,
            development=True,
        )
        self.assertEqual(prepared["mode"], "development")
        self.assertEqual(prepared["fixtureCount"], 4)

    def test_rejects_incomplete_review_before_writing_output(self) -> None:
        review = copy.deepcopy(self.review)
        review["fixtures"][0]["developmentRoleConfirmed"] = False

        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "development role is not confirmed",
        ):
            freeze_development_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

        self.assertFalse(self.output_root.exists())

    def test_consented_source_requires_signed_consent_review(self) -> None:
        review = copy.deepcopy(self.review)
        consented = next(
            item
            for item in review["fixtures"]
            if item["fixtureId"] == "development-consented-dialect"
        )
        consented["licenseOrConsent"] = "REVIEWED_FOR_LOCAL_BENCHMARK"

        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "signed consent review is required",
        ):
            freeze_development_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

    def test_dialect_source_requires_independent_variety_review(self) -> None:
        review = copy.deepcopy(self.review)
        dialect = next(
            item
            for item in review["fixtures"]
            if item["fixtureId"] == "development-consented-dialect"
        )
        dialect["varietyReview"] = "PENDING"
        dialect["varietyReviewRecordSha256"] = None

        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "variety review is required",
        ):
            freeze_development_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

    def test_rejects_future_provenance_review_date(self) -> None:
        review = copy.deepcopy(self.review)
        review["fixtures"][0]["sourceProvenanceRecordDate"] = "2999-01-01"

        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "source provenance record date is required",
        ):
            freeze_development_manifest(
                self.manifest,
                review,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

    def test_rejects_wrong_pcm_without_partial_freeze(self) -> None:
        fixture = self._development_fixtures()[0]
        audio_path = self._local_path(fixture["audio"]["relativePath"])
        with wave.open(str(audio_path), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(16000)
            target.writeframes(struct.pack("<32000h", *([0] * 32000)))

        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "channels mismatch",
        ):
            freeze_development_manifest(
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
            DevelopmentFixtureFreezeError,
            "fixture manifest identity mismatch",
        ):
            freeze_development_manifest(
                self.manifest,
                stale,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

        private = copy.deepcopy(self.review)
        private["absolutePath"] = "/Users/person/private.wav"
        with self.assertRaisesRegex(
            DevelopmentFixtureFreezeError,
            "review receipt fields mismatch",
        ):
            freeze_development_manifest(
                self.manifest,
                private,
                repository_root=self.repository_root,
                output_root=self.output_root,
            )

    def _completed_review(self) -> dict:
        template = build_review_template(self.manifest)
        for item in template["fixtures"]:
            item["sourceProvenanceRecordSha256"] = hashlib.sha256(
                f"{item['fixtureId']}:provenance".encode()
            ).hexdigest()
            item["sourceProvenanceRecordDate"] = "2026-07-26"
            item["licenseOrConsent"] = (
                "SIGNED_CONSENT_REVIEWED_FOR_LOCAL_BENCHMARK"
                if item["sourceKind"] == "consented_internal_recording"
                else "REVIEWED_FOR_LOCAL_BENCHMARK"
            )
            item["licenseOrConsentRecordSha256"] = hashlib.sha256(
                f"{item['fixtureId']}:license".encode()
            ).hexdigest()
            item["licenseOrConsentRecordDate"] = "2026-07-26"
            item["referenceReview"] = "REVIEWED"
            item["referenceReviewRecordSha256"] = hashlib.sha256(
                f"{item['fixtureId']}:reference".encode()
            ).hexdigest()
            if item["scenario"] == "dialect_accent":
                item["varietyReview"] = "REVIEWED"
                item["varietyReviewRecordSha256"] = hashlib.sha256(
                    f"{item['fixtureId']}:variety".encode()
                ).hexdigest()
            item["developmentRoleConfirmed"] = True
            item["redistributionConfirmed"] = "never_commit"
            item["localOnlyConfirmed"] = True
        return template

    def _write_local_sources(self) -> None:
        for fixture in self._development_fixtures():
            audio = self._local_path(fixture["audio"]["relativePath"])
            reference = self._local_path(fixture["reference"]["relativePath"])
            audio.parent.mkdir(parents=True, exist_ok=True)
            reference.parent.mkdir(parents=True, exist_ok=True)
            audio.write_bytes(self._wav_bytes())
            reference.write_text("测试参考", encoding="utf-8")

    def _local_path(self, relative: str) -> Path:
        local_root = (
            self.repository_root
            / self.manifest["privacyPolicy"]["localOnlyRoot"]
        )
        relative_path = Path(relative)
        return local_root / Path(*relative_path.parts[1:])

    def _development_fixtures(self) -> list[dict]:
        return [
            fixture
            for fixture in self.manifest["fixtures"]
            if fixture["fixtureRole"] == "development"
        ]

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
