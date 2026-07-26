import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("build_cache_guard.py")
SPEC = importlib.util.spec_from_file_location("build_cache_guard", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildCacheGuardTest(unittest.TestCase):
    def test_managed_usage_only_counts_generated_directories(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = pathlib.Path(temporary_directory)
            sizes = {
                root / "build": 5,
                root / ".dart_tool" / "flutter_build": 7,
                root / "android" / ".gradle": 11,
            }

            usage = MODULE.managed_cache_usage(
                root,
                size_reader=lambda path: sizes.get(path, 0),
            )

            self.assertEqual(usage.total_bytes, 23)
            self.assertEqual(usage.parts["build"], 5)
            self.assertEqual(usage.parts[".dart_tool/flutter_build"], 7)
            self.assertEqual(usage.parts["android/.gradle"], 11)

    def test_below_budget_does_not_clean(self):
        commands = []

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            usage_reader=lambda _: MODULE.CacheUsage({}, 19),
            active_process_reader=lambda: [],
            command_runner=lambda *args, **kwargs: commands.append((args, kwargs)),
        )

        self.assertFalse(result.cleaned)
        self.assertFalse(result.would_clean)
        self.assertEqual(commands, [])

    def test_over_budget_runs_standard_and_project_cleaners(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        commands = []

        result = MODULE.enforce_budget(
            root,
            limit_bytes=20,
            usage_reader=lambda _: MODULE.CacheUsage({}, 21),
            active_process_reader=lambda: [],
            command_runner=lambda command, **kwargs: commands.append(
                (tuple(command), kwargs)
            ),
        )

        self.assertTrue(result.cleaned)
        self.assertFalse(result.would_clean)
        self.assertEqual(
            commands,
            [
                (("flutter", "clean"), {"cwd": root, "check": True}),
                (
                    (
                        "bash",
                        "scripts/clean_flutter_android_artifacts.sh",
                        "--run",
                        "--yes",
                    ),
                    {"cwd": root, "check": True},
                ),
            ],
        )

    def test_force_cleans_even_below_budget(self):
        commands = []

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            force=True,
            usage_reader=lambda _: MODULE.CacheUsage({}, 1),
            active_process_reader=lambda: [],
            command_runner=lambda command, **kwargs: commands.append(command),
        )

        self.assertTrue(result.cleaned)
        self.assertEqual(len(commands), 2)

    def test_dry_run_reports_without_cleaning(self):
        commands = []

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            dry_run=True,
            usage_reader=lambda _: MODULE.CacheUsage({}, 21),
            active_process_reader=lambda: [],
            command_runner=lambda *args, **kwargs: commands.append((args, kwargs)),
        )

        self.assertFalse(result.cleaned)
        self.assertTrue(result.would_clean)
        self.assertEqual(commands, [])

    def test_active_build_process_blocks_cleanup(self):
        commands = []

        with self.assertRaisesRegex(RuntimeError, "flutter test"):
            MODULE.enforce_budget(
                pathlib.Path("/tmp/voice2text-flutter"),
                limit_bytes=20,
                usage_reader=lambda _: MODULE.CacheUsage({}, 21),
                active_process_reader=lambda: ["123 flutter test"],
                command_runner=lambda *args, **kwargs: commands.append(
                    (args, kwargs)
                ),
            )

        self.assertEqual(commands, [])

    def test_heavy_scripts_guard_before_building(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        for relative_path, build_marker in (
            ("tool/dev_check.sh", "flutter analyze"),
            ("tool/preflight_release.sh", "flutter analyze"),
            ("tool/run_android_smoke.sh", "flutter build apk"),
        ):
            with self.subTest(script=relative_path):
                script = (root / relative_path).read_text()
                self.assertLess(
                    script.index("python3 tool/build_cache_guard.py"),
                    script.index(build_marker),
                )
                if relative_path == "tool/run_android_smoke.sh":
                    self.assertLess(
                        script.index('cd "$ROOT"'),
                        script.index("python3 tool/build_cache_guard.py"),
                    )


if __name__ == "__main__":
    unittest.main()
