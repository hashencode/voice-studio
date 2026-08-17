import importlib.util
import os
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("build_cache_guard.py")
SPEC = importlib.util.spec_from_file_location("build_cache_guard", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildCacheGuardTest(unittest.TestCase):
    def test_default_budgets_match_clean_cross_platform_workflow(self):
        self.assertEqual(MODULE.DEFAULT_LIMIT_GIB, 8.0)
        self.assertEqual(
            {
                project.relative_path.as_posix(): project.cache_limit_gib
                for project in MODULE.FLUTTER_PROJECTS
            },
            {
                "apps/mobile-flutter": 7.0,
                "apps/codex_ui_reproduction": 0.5,
                "packages/audio_core": 0.5,
                "packages/audio_storage": 0.5,
                "packages/audio_workflows": 0.5,
                "packages/companion_protocol": 0.5,
                "packages/desktop_sherpa_worker": 0.5,
                "packages/meeting_core": 0.5,
                "packages/meeting_storage": 0.5,
                "packages/meeting_workflows": 0.5,
                "packages/processing_contracts": 0.5,
            },
        )

    def test_project_whitelist_matches_repository_pubspec_roots(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        discovered = set()
        for directory, directory_names, file_names in os.walk(root):
            directory_names[:] = [
                name
                for name in directory_names
                if name not in {".dart_tool", ".git", "build"}
            ]
            if "pubspec.yaml" in file_names and pathlib.Path(directory) != root:
                relative_path = pathlib.Path(directory).relative_to(root)
                discovered.add(
                    relative_path
                )

        configured = {
            project.relative_path
            for project in MODULE.FLUTTER_PROJECTS
        }

        self.assertEqual(configured, discovered)

    def test_managed_usage_covers_every_flutter_project(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        expected_paths = []
        for project in MODULE.FLUTTER_PROJECTS:
            for relative_path in (pathlib.Path("build"), pathlib.Path(".dart_tool")):
                expected_paths.append(MODULE.cache_label(project, relative_path))
            if project.clean_android_gradle:
                expected_paths.append(
                    MODULE.cache_label(project, pathlib.Path("android/.gradle"))
                )
        sizes = {
            root / relative_path: index
            for index, relative_path in enumerate(expected_paths, start=1)
        }

        usage = MODULE.managed_cache_usage(
            root,
            size_reader=lambda path: sizes.get(path, 0),
        )

        self.assertEqual(tuple(usage.parts), tuple(expected_paths))
        self.assertEqual(usage.total_bytes, sum(sizes.values()))

    def test_below_budget_preserves_incremental_artifacts(self):
        commands = []
        removed = []

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            usage_reader=lambda _: MODULE.CacheUsage({}, 19),
            active_process_reader=lambda: [],
            command_runner=lambda *args, **kwargs: commands.append((args, kwargs)),
            remove_tree=lambda path: removed.append(path),
        )

        self.assertFalse(result.cleaned)
        self.assertFalse(result.would_clean)
        self.assertFalse(result.deferred)
        self.assertIsNone(result.remaining_usage)
        self.assertEqual(commands, [])
        self.assertEqual(removed, [])

    def test_project_budget_triggers_repository_cleanup(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        project = MODULE.FLUTTER_PROJECTS[1]
        label = MODULE.cache_label(project, pathlib.Path("build"))
        usages = iter(
            (
                MODULE.CacheUsage({label: 4}, 4),
                MODULE.CacheUsage({}, 0),
            )
        )
        project_limits = {
            configured.relative_path: 10
            for configured in MODULE.FLUTTER_PROJECTS
        }
        project_limits[project.relative_path] = 3
        commands = []

        result = MODULE.enforce_budget(
            root,
            limit_bytes=20,
            project_limits=project_limits,
            usage_reader=lambda _: next(usages),
            active_process_reader=lambda: [],
            command_runner=lambda command, **kwargs: commands.append(
                (tuple(command), kwargs)
            ),
            remove_tree=lambda _: None,
        )

        self.assertTrue(result.cleaned)
        expected = [
            (
                ("flutter", "clean"),
                {"cwd": root / project.relative_path, "check": True},
            )
            for project in MODULE.FLUTTER_PROJECTS
        ]
        expected.append(
            (
                ("flutter", "pub", "get", "--enforce-lockfile"),
                {"cwd": root, "check": True},
            )
        )
        self.assertEqual(commands, expected)

    def test_force_cleans_all_projects_and_only_app_gradle_cache(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        usages = iter((MODULE.CacheUsage({}, 1), MODULE.CacheUsage({}, 0)))
        commands = []
        removed = []

        result = MODULE.enforce_budget(
            root,
            limit_bytes=20,
            force=True,
            usage_reader=lambda _: next(usages),
            active_process_reader=lambda: [],
            command_runner=lambda command, **kwargs: commands.append(
                (tuple(command), kwargs)
            ),
            remove_tree=lambda path: removed.append(path),
        )

        self.assertTrue(result.cleaned)
        self.assertEqual(result.remaining_usage.total_bytes, 0)
        self.assertEqual(
            commands[-1],
            (
                ("flutter", "pub", "get", "--enforce-lockfile"),
                {"cwd": root, "check": True},
            ),
        )
        self.assertEqual(
            removed,
            [root / "apps/mobile-flutter" / "android" / ".gradle"],
        )

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
        self.assertFalse(result.deferred)
        self.assertEqual(commands, [])

    def test_busy_repository_defers_without_cleaning(self):
        commands = []

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            usage_reader=lambda _: MODULE.CacheUsage({}, 21),
            active_process_reader=lambda: ["123 flutter test"],
            command_runner=lambda *args, **kwargs: commands.append((args, kwargs)),
        )

        self.assertTrue(result.deferred)
        self.assertEqual(result.active_processes, ("123 flutter test",))
        self.assertEqual(commands, [])

    def test_active_build_processes_are_scoped_to_repository(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        process_cwds = {
            123: pathlib.Path("/tmp/another-app"),
            456: root / "apps" / "desktop",
            457: root / "apps/mobile-flutter" / "android",
        }

        active = MODULE.active_build_processes(
            root,
            process_reader=lambda: [
                (123, "flutter test"),
                (456, "dart test"),
                (
                    457,
                    "java -classpath /tmp/voice2text-flutter/android/"
                    "gradle-wrapper.jar "
                    "org.gradle.wrapper.GradleWrapperMain assembleDebug",
                ),
                (789, "python3 tool/build_cache_guard.py"),
            ],
            cwd_reader=lambda pid: process_cwds.get(pid),
        )

        self.assertEqual(
            active,
            [
                "456 dart test",
                "457 java -classpath /tmp/voice2text-flutter/android/"
                "gradle-wrapper.jar "
                "org.gradle.wrapper.GradleWrapperMain assembleDebug",
            ],
        )

    def test_wait_for_idle_cleans_after_process_finishes(self):
        root = pathlib.Path("/tmp/voice2text-flutter")
        process_states = iter((["123 flutter test"], []))
        clock = iter((0.0, 0.0, 1.0))
        usages = iter((MODULE.CacheUsage({}, 21), MODULE.CacheUsage({}, 0)))
        commands = []

        result = MODULE.enforce_budget(
            root,
            limit_bytes=20,
            wait_for_idle=True,
            wait_timeout_seconds=30,
            poll_interval_seconds=2,
            usage_reader=lambda _: next(usages),
            active_process_reader=lambda: next(process_states),
            command_runner=lambda command, **kwargs: commands.append(command),
            remove_tree=lambda _: None,
            monotonic_reader=lambda: next(clock),
            sleeper=lambda _: None,
        )

        self.assertTrue(result.cleaned)
        self.assertFalse(result.deferred)
        self.assertEqual(len(commands), len(MODULE.FLUTTER_PROJECTS) + 1)

    def test_wait_for_idle_defers_after_timeout(self):
        clock = iter((0.0, 30.0))

        result = MODULE.enforce_budget(
            pathlib.Path("/tmp/voice2text-flutter"),
            limit_bytes=20,
            wait_for_idle=True,
            wait_timeout_seconds=30,
            usage_reader=lambda _: MODULE.CacheUsage({}, 21),
            active_process_reader=lambda: ["123 flutter test"],
            command_runner=lambda *args, **kwargs: self.fail(
                f"unexpected cleanup: {args} {kwargs}"
            ),
            monotonic_reader=lambda: next(clock),
            sleeper=lambda _: None,
        )

        self.assertTrue(result.deferred)
        self.assertEqual(result.active_processes, ("123 flutter test",))

    def test_validation_rejects_symlinked_cache_directory(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = pathlib.Path(temporary_directory)
            for project in MODULE.FLUTTER_PROJECTS:
                project_root = root / project.relative_path
                project_root.mkdir(parents=True, exist_ok=True)
                (project_root / "pubspec.yaml").touch()

            external = root / "external-build"
            external.mkdir()
            (
                root / "packages" / "desktop_sherpa_worker" / "build"
            ).symlink_to(
                external,
                target_is_directory=True,
            )

            with self.assertRaisesRegex(SystemExit, "symbolic link"):
                MODULE.validate_repository(root)

    def test_limits_must_be_finite_and_non_negative(self):
        for value in ("nan", "inf", "-inf", "-1"):
            with self.subTest(value=value):
                with self.assertRaises(MODULE.argparse.ArgumentTypeError):
                    MODULE.parse_non_negative_number(value)

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
                    self.assertLess(
                        script.index('cd "$MOBILE_ROOT"'),
                        script.index("flutter build apk"),
                    )

    def test_ui_watcher_exits_through_cleanup_on_signal(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        script = (root / "tool" / "watch_ui_device.sh").read_text()
        start = script.index("start_flutter_run()")
        guard = script.index(
            'python3 "$ROOT/tool/build_cache_guard.py" --wait-for-idle',
            start,
        )

        self.assertIn("trap cleanup EXIT", script)
        self.assertIn("trap 'exit 0' INT TERM", script)
        self.assertLess(guard, script.index('mkdir -p "$LOG_DIR"', start))
        self.assertLess(guard, script.index("flutter_command=(", start))
        self.assertIn("../../pubspec.lock", script)
        self.assertIn("android/*|assets/*|pubspec.yaml|../../pubspec.lock", script)

    def test_android_smoke_keeps_logs_under_repository_build(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        script = (root / "tool" / "run_android_smoke.sh").read_text()

        self.assertIn('LOG_DIR="$ROOT/build/smoke"', script)
        self.assertIn('$ROOT/tool/check_transcribe_log.sh $LOG_FILE', script)

    def test_dev_check_validates_removal_before_desktop_foundation(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        script = (root / "tool" / "dev_check.sh").read_text()

        self.assertLess(
            script.index("tool/test_validate_electron_desktop_removal.py"),
            script.index("./tool/check_desktop_foundation.sh"),
        )


if __name__ == "__main__":
    unittest.main()
