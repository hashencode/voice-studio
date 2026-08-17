from __future__ import annotations

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tool.validate_electron_desktop_removal import (
    _validate_no_retired_consumers,
    _path_tree_sha256,
    _sha256,
    _tracked_path_tree_sha256,
    validate_electron_desktop_removal,
)


class ElectronDesktopRemovalValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest_path = (
            self.root / "docs/product/desktop-electron-removal.json"
        )
        self.manifest_path.parent.mkdir(parents=True)

        historical = []
        for name in (
            "desktop-electron-u12-scope.json",
            "desktop-electron-evidence.json",
            "desktop-electron-parity-baseline.json",
        ):
            path = self._write(f"docs/product/{name}", name.encode())
            historical.append(
                {
                    "path": path.relative_to(self.root).as_posix(),
                    "sha256": _sha256(path),
                }
            )

        archived_source = self._write(
            "apps/desktop-electron/tests/fixtures/flutter-reference/source/example.dart",
            b"archived reference\n",
        )
        protected = self._write(
            "packages/desktop_sherpa_worker/bin/worker.dart",
            b"worker\n",
        )
        consumer = self._write("tool/dev_check.sh", b"#!/bin/sh\n")
        self.manifest = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "schema": "voice2text-desktop-electron-removal/v1",
            "unit": "U14",
            "status": "PASS",
            "supportScope": {
                "decisionId": "MACOS_ONLY_SUPPORTED_SCOPE_2026_08_17",
                "authority": "user-directed",
                "supportedTargets": ["macos"],
                "windows": {
                    "status": "DEFERRED_OUT_OF_CURRENT_SCOPE",
                    "inheritsMacosPass": False,
                    "evidence": None,
                },
            },
            "historicalClosure": historical,
            "archivedFlutterEvidence": [
                {
                    "originalPath": "apps/desktop/example.dart",
                    "archivePath": archived_source.relative_to(
                        self.root
                    ).as_posix(),
                    "sha256": _sha256(archived_source),
                }
            ],
            "comparisonBaseRevision": "0" * 40,
            "relocatedAuthorities": [
                {
                    "originalPath": "apps/desktop/tool/worker.dart",
                    "destinationPath": protected.relative_to(self.root).as_posix(),
                    "sha256": _sha256(protected),
                }
            ],
            "protectedPaths": [
                {
                    "path": protected.parent.relative_to(
                        self.root
                    ).as_posix(),
                    "treeSha256": _path_tree_sha256(protected.parent),
                }
            ],
            "activeConsumers": [consumer.relative_to(self.root).as_posix()],
            "flutterDesktop": {
                "sourceRoot": "apps/desktop",
                "trackedFilesExpected": 0,
                "worktreeState": "ABSENT",
            },
            "dataLifecycleImpact": {
                "electronProfile": "UNTOUCHED",
                "keychain": "UNTOUCHED",
                "media": "UNTOUCHED",
                "journals": "UNTOUCHED",
                "checkpoints": "UNTOUCHED",
                "receipts": "UNTOUCHED",
            },
            "verification": {
                "macosClosure": "PASS",
                "rootDevCheck": "PASS",
                "electronCheck": "PASS",
                "electronPackage": "PASS",
                "packageSmoke": "PASS",
                "removalDiffCheck": "PASS",
            },
            "blockers": [],
        }
        self.valid_manifest = copy.deepcopy(self.manifest)
        self._write_manifest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write(self, relative: str, content: bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def _write_manifest(self) -> None:
        self.manifest_path.write_text(
            json.dumps(self.manifest), encoding="utf-8"
        )

    def _validate(self) -> dict[str, object]:
        self._write_manifest()
        relocations = {
            (item["originalPath"], item["destinationPath"])
            for item in self.manifest["relocatedAuthorities"]
        }
        with (
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_ACTIVE_CONSUMERS",
                set(self.manifest["activeConsumers"]),
            ),
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_RELOCATED_AUTHORITIES",
                relocations,
            ),
        ):
            return validate_electron_desktop_removal(
                self.manifest_path,
                root=self.root,
                validate_repository=False,
            )

    def _initialize_repository_fixture(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(
            ["git", "config", "user.email", "fixture@example.invalid"],
            cwd=self.root,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Fixture"],
            cwd=self.root,
            check=True,
        )
        archived = self.root / self.manifest["archivedFlutterEvidence"][0][
            "archivePath"
        ]
        relocated = self.root / self.manifest["relocatedAuthorities"][0][
            "destinationPath"
        ]
        original_archive = self._write(
            "apps/desktop/example.dart",
            archived.read_bytes(),
        )
        original_relocation = self._write(
            "apps/desktop/tool/worker.dart",
            relocated.read_bytes(),
        )
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(
            ["git", "commit", "-qm", "fixture base"],
            cwd=self.root,
            check=True,
        )
        comparison_base = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        original_archive.unlink()
        original_relocation.unlink()
        (self.root / "apps/desktop/tool").rmdir()
        (self.root / "apps/desktop").rmdir()
        self.manifest["comparisonBaseRevision"] = comparison_base
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        protected_path = self.manifest["protectedPaths"][0]["path"]
        self.manifest["protectedPaths"][0]["treeSha256"] = (
            _tracked_path_tree_sha256(self.root, protected_path)
        )
        self._write_manifest()
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)

    def _validate_repository_fixture(self) -> dict[str, object]:
        relocations = {
            (item["originalPath"], item["destinationPath"])
            for item in self.manifest["relocatedAuthorities"]
        }
        with (
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_ACTIVE_CONSUMERS",
                set(self.manifest["activeConsumers"]),
            ),
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_PROTECTED_PATHS",
                {self.manifest["protectedPaths"][0]["path"]},
            ),
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_RELOCATED_AUTHORITIES",
                relocations,
            ),
        ):
            return validate_electron_desktop_removal(
                self.manifest_path,
                root=self.root,
                validate_repository=True,
            )

    def test_accepts_truthful_macos_only_removal(self) -> None:
        result = self._validate()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["supportedTargets"], ["macos"])

    def test_rejects_windows_pass_or_inherited_evidence(self) -> None:
        for mutation in (
            {"status": "PASS"},
            {"inheritsMacosPass": True},
            {"evidence": {"path": "windows.json"}},
        ):
            with self.subTest(mutation=mutation):
                candidate = copy.deepcopy(self.manifest)
                candidate["supportScope"]["windows"].update(mutation)
                self.manifest = candidate
                with self.assertRaisesRegex(ValueError, "Windows"):
                    self._validate()
                self.manifest = copy.deepcopy(self.valid_manifest)

    def test_rejects_historical_or_archive_hash_drift(self) -> None:
        for section, field in (
            ("historicalClosure", "path"),
            ("archivedFlutterEvidence", "archivePath"),
        ):
            with self.subTest(section=section):
                candidate = copy.deepcopy(self.manifest)
                path = self.root / candidate[section][0][field]
                path.write_bytes(b"drift\n")
                with self.assertRaisesRegex(ValueError, "hash drift"):
                    self._validate()
                path.write_bytes(
                    b"desktop-electron-u12-scope.json"
                    if section == "historicalClosure"
                    else b"archived reference\n"
                )

    def test_rejects_active_flutter_desktop_consumer(self) -> None:
        consumer = self.root / self.manifest["activeConsumers"][0]
        consumer.write_text("apps/desktop/tool/worker.dart\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "active consumer"):
            self._validate()

    def test_rejects_omitted_tracked_flutter_desktop_consumer(self) -> None:
        omitted = self._write(
            "tool/forgotten_consumer.sh",
            b'Path("apps/desktop")\n',
        )
        with self.assertRaisesRegex(ValueError, "tracked active file"):
            _validate_no_retired_consumers(
                self.root,
                [omitted.relative_to(self.root).as_posix()],
            )

    def test_rejects_destructive_runtime_data_action(self) -> None:
        self.manifest["dataLifecycleImpact"]["media"] = "DELETED"
        with self.assertRaisesRegex(ValueError, "data lifecycle"):
            self._validate()

    def test_rejects_missing_relocated_authority(self) -> None:
        required = {
            (item["originalPath"], item["destinationPath"])
            for item in self.manifest["relocatedAuthorities"]
        }
        self.manifest["relocatedAuthorities"] = []
        self._write_manifest()
        with (
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_ACTIVE_CONSUMERS",
                set(self.manifest["activeConsumers"]),
            ),
            patch(
                "tool.validate_electron_desktop_removal._REQUIRED_RELOCATED_AUTHORITIES",
                required,
            ),
            self.assertRaisesRegex(ValueError, "relocated authority"),
        ):
            validate_electron_desktop_removal(
                self.manifest_path,
                root=self.root,
                validate_repository=False,
            )

    def test_rejects_remaining_flutter_desktop_tree(self) -> None:
        (self.root / "apps/desktop").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "Flutter Desktop"):
            self._validate()

    def test_rejects_dangling_flutter_desktop_symlink(self) -> None:
        desktop = self.root / "apps/desktop"
        desktop.symlink_to(self.root / "missing-desktop", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Flutter Desktop"):
            self._validate()

    def test_repository_mode_binds_base_blobs_and_protected_tree(self) -> None:
        self._initialize_repository_fixture()
        self.assertEqual(self._validate_repository_fixture()["status"], "PASS")

        protected = self.root / self.manifest["relocatedAuthorities"][0][
            "destinationPath"
        ]
        protected.write_bytes(b"mutated\n")
        with self.assertRaisesRegex(ValueError, "relocated authority hash drift"):
            self._validate_repository_fixture()
        self.manifest["relocatedAuthorities"][0]["sha256"] = _sha256(protected)
        protected_path = self.manifest["protectedPaths"][0]["path"]
        self.manifest["protectedPaths"][0]["treeSha256"] = (
            _tracked_path_tree_sha256(self.root, protected_path)
        )
        self._write_manifest()
        with self.assertRaisesRegex(ValueError, "differs from comparison base"):
            self._validate_repository_fixture()

    def test_repository_mode_rejects_untracked_electron_source(self) -> None:
        self._initialize_repository_fixture()
        self._write("apps/desktop-electron/src/untracked.ts", b"export {};\n")
        with self.assertRaisesRegex(ValueError, "untracked Electron source"):
            self._validate_repository_fixture()

if __name__ == "__main__":
    unittest.main()
