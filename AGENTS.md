# Project Agent Instructions

## Goo component guidance

Treat the sibling `flutter-ui-mobile` project as the design and implementation authority for this app:

- Design guidance: `/Users/studio/Documents/GitHub/flutter-ui-mobile/DESIGN.md`
- Flutter development guidance: `/Users/studio/Documents/GitHub/flutter-ui-mobile/DOC.md`

Before changing UI, screens, navigation, visual states, or Flutter component usage, read and follow both files. In particular:

- Prefer exported `Goo*` components from `package:flutter_ui_mobile/flutter_ui_mobile.dart`.
- Do not invent undocumented Goo components, constructor arguments, enum values, variants, colors, shadows, motion, or surface styles.
- If the docs and the installed package API disagree, the API that imports and passes analyzer in this project wins.
- Use Goo design tokens and component variants before hand-writing Material surfaces, typography, colors, dividers, loading states, dialogs, panels, toasts, snackbars, or form controls.
- Preserve existing business behavior and platform contracts when migrating UI to Goo components.

Run the normal project checks after relevant changes:

```bash
./tool/dev_check.sh
```

## Verification lanes

Use the lightest lane that proves the changed behavior:

| Change                                                                                                              | Required Electron command                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Renderer layout, styling, navigation, or visual states                                                              | `bun run check:ui` from `apps/desktop-electron`                                      |
| Main, Preload, shared contracts, storage, or ordinary worker integration                                            | `bun run check:code` from `apps/desktop-electron`                                    |
| Release evidence, frozen-resource manifest/identity/packaged inventory, or an explicit user request for a candidate | `VOICE2TEXT_RELEASE_VALIDATION=1 bun run check:release` from `apps/desktop-electron` |

- Do not run `bun run package`, `resources:all`, or
  `audio_sidebar_release_candidate.py prepare` merely because a routine UI or
  code task changed files.
- The release lane is intentionally disabled unless release intent is explicit.
  Direct invocation of `python3 tool/audio_sidebar_release_candidate.py prepare`
  remains available only for genuine candidate recovery or diagnostics.
- A failed release preparation resumes its verified command prefix only when
  source, target, toolchain, environment, acquisition mode, and package
  identities still match.

## Frozen resource download cache

- Frozen Electron resources are cached by verified SHA-256 under
  `${HOME}/Library/Caches/Voice2Text/resource-downloads-v1` and shared by local
  worktrees. Cache hits are rehashed before use.
- Override the location with `VOICE2TEXT_RESOURCE_CACHE_DIR`, the 4 GiB ceiling
  with `VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB`, or request a deliberate fresh
  acquisition with `VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD=1`.
- Do not delete the shared cache in task cleanup. Disposable materialization
  staging is separate and is removed automatically.

## Build cache budget

- Before running local Flutter or Gradle builds, tests, benchmarks, or code
  generation, run `python3 tool/build_cache_guard.py`.
- The guard covers the root app, `apps/desktop`, and every workspace package.
  It preserves incremental artifacts below the measured 8 GiB repository
  budget and also enforces per-project budgets.
- If this repository has an active Dart, Flutter, Gradle, or Xcode process,
  cleanup is deferred without failing the caller. Use `--wait-for-idle` when
  cleanup should wait for the repository to become idle.
- Override the budget with `VOICE2TEXT_BUILD_CACHE_LIMIT_GIB` only for a
  documented benchmark. Use `python3 tool/build_cache_guard.py --force` after a
  one-off full build matrix.

## UI device watcher

After generating or changing code in this `voice2text-flutter` project, run this best-effort watcher check before finishing:

```bash
./tool/ensure_ui_watcher.sh
```

The script starts `tool/watch_ui_device.sh` only when a physical Android device is connected and the watcher is not already running. If no physical device is connected, or the watcher is already running, it exits without changing anything.
