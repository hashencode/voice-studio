# Build and resource handling standard

Applies when running builds, tests, generation, resource acquisition, or device watchers.

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

After generating or changing code in this `voice2text-flutter` project, run this best-effort watcher check before finishing only when the user has explicitly authorized visual validation for the current task:

```bash
./tool/ensure_ui_watcher.sh
```

Without that permission, do not run the script. When authorized, the script starts `tool/watch_ui_device.sh` only when a physical Android device is connected and the watcher is not already running. If no physical device is connected, or the watcher is already running, it exits without changing anything.
