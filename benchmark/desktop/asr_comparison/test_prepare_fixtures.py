from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from prepare_fixtures import (
    FixtureError,
    prepare,
    resolve_fixture_source,
    validate_manifest,
)


ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = ROOT.parents[2]


class PrepareFixturesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads((ROOT / "fixtures.json").read_text())
        self.temporary = tempfile.TemporaryDirectory()
        self.output = Path(self.temporary.name) / "active"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_manifest_describes_all_roles_and_scenarios(self) -> None:
        validate_manifest(self.manifest, ranked=False)
        self.assertEqual(
            {item["fixtureRole"] for item in self.manifest["fixtures"]},
            {"smoke", "development", "held_out", "long_7200s"},
        )
        held_out = {
            item["scenario"]
            for item in self.manifest["fixtures"]
            if item["fixtureRole"] == "held_out"
        }
        self.assertEqual(
            held_out,
            set(self.manifest["requiredHeldOutScenarios"]),
        )

    def test_prepares_committed_and_generated_smoke_pack(self) -> None:
        result = prepare(
            self.manifest,
            repository_root=REPOSITORY_ROOT,
            output_root=self.output,
            ranked=False,
        )
        self.assertEqual(result["mode"], "smoke")
        self.assertEqual(result["fixtureCount"], 6)
        self.assertTrue((self.output / "fixtures" / "committed-zh-300s.wav").is_file())
        self.assertTrue(
            (self.output / "fixtures" / "generated-zh-prefix-15s.wav").is_file()
        )
        self.assertTrue((self.output / "fixtures" / "generated-silence-1s.wav").is_file())
        self.assertFalse(any(path.is_absolute() for path in map(Path, result["files"])))

    def test_smoke_preparation_is_idempotent(self) -> None:
        first = prepare(
            self.manifest,
            repository_root=REPOSITORY_ROOT,
            output_root=self.output,
            ranked=False,
        )
        second = prepare(
            self.manifest,
            repository_root=REPOSITORY_ROOT,
            output_root=self.output,
            ranked=False,
        )
        self.assertEqual(first, second)

    def test_rejects_development_held_out_group_leakage(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        development = next(
            item for item in manifest["fixtures"] if item["fixtureRole"] == "development"
        )
        held_out = next(
            item for item in manifest["fixtures"] if item["fixtureRole"] == "held_out"
        )
        held_out["speakerGroupId"] = development["speakerGroupId"]
        with self.assertRaisesRegex(FixtureError, "role leakage"):
            validate_manifest(manifest, ranked=False)

    def test_ranked_mode_rejects_missing_local_only_assets(self) -> None:
        with self.assertRaisesRegex(FixtureError, "ranked fixture is not frozen"):
            prepare(
                self.manifest,
                repository_root=REPOSITORY_ROOT,
                output_root=self.output,
                ranked=True,
            )
        self.assertFalse(self.output.exists())

    def test_development_mode_never_requires_held_out_or_long_assets(self) -> None:
        with self.assertRaisesRegex(
            FixtureError, "development fixture is not frozen"
        ) as caught:
            prepare(
                self.manifest,
                repository_root=REPOSITORY_ROOT,
                output_root=self.output,
                ranked=False,
                development=True,
            )
        self.assertIn("development-", str(caught.exception))
        self.assertNotIn("heldout-", str(caught.exception))
        self.assertNotIn("finalist-", str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_development_and_ranked_modes_are_mutually_exclusive(self) -> None:
        with self.assertRaisesRegex(FixtureError, "mutually exclusive"):
            validate_manifest(
                self.manifest,
                ranked=True,
                development=True,
            )

    def test_ranked_mode_rejects_unreviewed_dialect_metadata(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        dialect = next(
            item
            for item in manifest["fixtures"]
            if item["fixtureRole"] == "held_out"
            and item["scenario"] == "dialect_accent"
        )
        dialect["audio"]["sha256"] = "a" * 64
        dialect["audio"]["bytes"] = 1
        dialect["reference"]["sha256"] = "b" * 64
        dialect["reference"]["bytes"] = 1
        dialect["freezeState"] = "FROZEN"
        dialect["referenceReview"] = "REVIEWED"
        dialect["varietyReview"] = "PENDING"
        with self.assertRaisesRegex(FixtureError, "variety metadata"):
            validate_manifest(manifest, ranked=True)

    def test_rejects_absolute_or_private_source_paths(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["fixtures"][0]["audio"]["relativePath"] = "/Users/person/private.wav"
        with self.assertRaisesRegex(FixtureError, "relative path"):
            validate_manifest(manifest, ranked=False)

    def test_local_only_sources_resolve_under_ignored_privacy_root(self) -> None:
        fixture = next(
            item
            for item in self.manifest["fixtures"]
            if item["fixtureId"] == "development-common-voice-clean"
        )
        repository_root = Path("/workspace")

        resolved = resolve_fixture_source(
            self.manifest,
            fixture,
            fixture["audio"],
            repository_root=repository_root,
            location=f"{fixture['fixtureId']}.audio",
        )

        self.assertEqual(
            resolved,
            repository_root
            / "build/desktop_asr_comparison/fixtures/local_sources"
            / "common_voice/development_clean.wav",
        )
        self.assertNotEqual(
            resolved,
            repository_root / "local_sources/common_voice/development_clean.wav",
        )

    def test_local_only_source_must_use_manifest_namespace(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        fixture = next(
            item
            for item in manifest["fixtures"]
            if item["fixtureId"] == "development-common-voice-clean"
        )
        fixture["audio"]["relativePath"] = "private/development_clean.wav"

        with self.assertRaisesRegex(FixtureError, "local-only namespace"):
            validate_manifest(manifest, ranked=False)

    def test_local_only_source_rejects_symlink_escape(self) -> None:
        fixture = next(
            item
            for item in self.manifest["fixtures"]
            if item["fixtureId"] == "development-common-voice-clean"
        )
        repository_root = Path(self.temporary.name)
        local_root = (
            repository_root
            / "build/desktop_asr_comparison/fixtures/local_sources"
        )
        outside = repository_root / "outside"
        local_root.mkdir(parents=True)
        outside.mkdir()
        (local_root / "common_voice").symlink_to(
            outside,
            target_is_directory=True,
        )

        with self.assertRaisesRegex(FixtureError, "escapes privacy root"):
            resolve_fixture_source(
                self.manifest,
                fixture,
                fixture["audio"],
                repository_root=repository_root,
                location=f"{fixture['fixtureId']}.audio",
            )

    def test_hash_drift_does_not_activate_partial_pack(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        committed = next(
            item
            for item in manifest["fixtures"]
            if item["fixtureId"] == "committed-zh-300s"
        )
        committed["audio"]["sha256"] = "f" * 64
        with self.assertRaisesRegex(FixtureError, "hash mismatch"):
            prepare(
                manifest,
                repository_root=REPOSITORY_ROOT,
                output_root=self.output,
                ranked=False,
            )
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
