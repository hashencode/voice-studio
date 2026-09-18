import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from rules_for_change import REPO_ROOT, RuleRouteError, load_index, resolve_rules


class RulesForChangeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = load_index()

    def test_renderer_and_main_rules_are_unioned_without_duplicates(self):
        self.assertEqual(
            resolve_rules(
                self.index,
                [
                    "apps/desktop-electron/src/renderer/App.tsx",
                    "apps/desktop-electron/src/main/index.ts",
                ],
                [],
            ),
            [
                "docs/standards/electron-renderer.md",
                "docs/standards/verification.md",
                "docs/standards/visual-style.md",
            ],
        )

    def test_flutter_and_package_paths_include_build_rules(self):
        self.assertEqual(
            resolve_rules(
                self.index,
                ["apps/mobile-flutter/lib/main.dart", "packages/audio_core/lib/audio.dart"],
                [],
            ),
            [
                "docs/standards/build-resources.md",
                "docs/standards/flutter-ui.md",
                "docs/standards/verification.md",
                "docs/standards/visual-style.md",
            ],
        )

    def test_task_tag_adds_rules_to_documentation_change(self):
        self.assertEqual(
            resolve_rules(self.index, ["docs/architecture/example.md"], ["electron-ui"]),
            [
                "docs/standards/electron-renderer.md",
                "docs/standards/verification.md",
                "docs/standards/visual-style.md",
            ],
        )

    def test_unknown_path_and_tag_fail_closed(self):
        with self.assertRaisesRegex(RuleRouteError, "no rule route"):
            resolve_rules(self.index, ["new-app/src/main.ts"], [])
        with self.assertRaisesRegex(RuleRouteError, "no rule route"):
            resolve_rules(self.index, ["new-app/src/config.json"], [])
        with self.assertRaisesRegex(RuleRouteError, "unknown task tag"):
            resolve_rules(self.index, [], ["unknown"])

    def test_missing_document_fails_index_validation(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            path.write_text(
                '{"version":1,"routes":[{"id":"broken","paths":["tool/**"],'
                '"documents":["docs/standards/missing.md"]}]}'
            )
            with self.assertRaisesRegex(RuleRouteError, "missing or invalid rule document"):
                load_index(path)

    def test_all_tracked_production_paths_have_a_route(self):
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z"], cwd=REPO_ROOT
        ).decode().split("\0")
        production_prefixes = (
            "apps/", "packages/", "lib/", "test/", "integration_test/",
            "android/", "ios/", "tool/", "scripts/", ".github/",
        )
        missing = []
        for path in tracked:
            if not path.startswith(production_prefixes):
                continue
            try:
                resolve_rules(self.index, [path], [])
            except RuleRouteError:
                missing.append(path)
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
