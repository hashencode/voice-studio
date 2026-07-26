# Project Agent Instructions

## Goo component guidance

Treat the sibling `flutter-components` project as the design and implementation authority for this app:

- Design guidance: `/Users/studio/Documents/GitHub/flutter-components/DESIGN.md`
- Flutter development guidance: `/Users/studio/Documents/GitHub/flutter-components/DOC.md`

Before changing UI, screens, navigation, visual states, or Flutter component usage, read and follow both files. In particular:

- Prefer exported `Goo*` components from `package:flutter_components/flutter_components.dart`.
- Do not invent undocumented Goo components, constructor arguments, enum values, variants, colors, shadows, motion, or surface styles.
- If the docs and the installed package API disagree, the API that imports and passes analyzer in this project wins.
- Use Goo design tokens and component variants before hand-writing Material surfaces, typography, colors, dividers, loading states, dialogs, panels, toasts, snackbars, or form controls.
- Preserve existing business behavior and platform contracts when migrating UI to Goo components.

Run the normal project checks after relevant changes:

```bash
./tool/dev_check.sh
```

## Build cache budget

- Before running local Flutter or Gradle builds, tests, benchmarks, or code
  generation, run `python3 tool/build_cache_guard.py`.
- The guard preserves incremental artifacts below 20 GiB and runs the standard
  project cleaners only after the managed cache exceeds that budget.
- Override the budget with `VOICE2TEXT_BUILD_CACHE_LIMIT_GIB` only for a
  documented benchmark. Use `python3 tool/build_cache_guard.py --force` after a
  one-off full build matrix.

## UI device watcher

After generating or changing code in this `voice2text-flutter` project, run this best-effort watcher check before finishing:

```bash
./tool/ensure_ui_watcher.sh
```

The script starts `tool/watch_ui_device.sh` only when a physical Android device is connected and the watcher is not already running. If no physical device is connected, or the watcher is already running, it exits without changing anything.
