# Verification standard

Applies to repository changes. The root `AGENTS.md` is the sole authority for
visual-validation permission; check that gate before selecting a UI lane below.

## Verification lanes

Use the lightest lane that proves the changed behavior. Routine work must not run
the 20-stage `./tool/dev_check.sh` by default.

| Change | Required verification |
| --- | --- |
| Documentation, comments, or analysis-only work | Inspect the diff and check affected references for consistency. Do not run tests, analyzers, or builds. |
| Electron renderer layout, styling, navigation, or visual states | Run `bun run check:ui:quick` and the final `bun run check:ui` from `apps/desktop-electron` only after the user explicitly authorizes visual validation for the current task. Otherwise skip them and report that visual validation was not authorized. Do not rerun the final check unless UI code changes after that result. |
| Electron Main, Preload, shared contracts, storage, or ordinary worker integration | Run `bun run check:code` from `apps/desktop-electron`. |
| Electron release evidence, frozen-resource manifest/identity/packaged inventory, or an explicit candidate request | Run `VOICE2TEXT_RELEASE_VALIDATION=1 bun run check:release` from `apps/desktop-electron`. |
| Pure Dart package (`audio_core`, `audio_workflows`, `companion_protocol`, `desktop_sherpa_worker`, or `processing_contracts`) | Run `dart analyze packages/<package>` and `dart test packages/<package>`. |
| Flutter package (`packages/audio_storage`) | From the repository root, first run `python3 tool/build_cache_guard.py`, then run `flutter analyze packages/audio_storage` and `flutter test packages/audio_storage/test`. |
| Flutter app (`apps/mobile-flutter`) | From the repository root, first run `python3 tool/build_cache_guard.py`; then, from the changed app directory, run `flutter analyze` and the narrowest relevant `flutter test <test-path>`. |
| Cross-module or repository-wide release work, explicit full-validation request, or a change whose reverse-dependency set cannot be bounded | Run the complete `./tool/dev_check.sh` gate from the repository root. The dedicated Electron candidate row above takes precedence for Electron-only release evidence. |

- Derive additional affected packages and apps from root workspace membership,
  `pubspec.yaml` path dependencies, and import/reference searches. If that
  evidence cannot bound the reverse-dependency set, use the complete gate.
- Run the corresponding lane for every derived reverse consumer, not only the
  directly changed package. This includes affected Flutter apps and Electron
  worker or processing-contract integrations.
- Deduplicate equivalent checks for the same code state. Do not repeat a
  narrower check after an equivalent broader lane has passed.
- Isolate and report unrelated pre-existing failures with evidence instead of
  rerunning them.

- Do not run `bun run package`, `resources:all`, or
  `audio_sidebar_release_candidate.py prepare` merely because a routine UI or
  code task changed files.
- The release lane is intentionally disabled unless release intent is explicit.
  Direct invocation of `python3 tool/audio_sidebar_release_candidate.py prepare`
  remains available only for genuine candidate recovery or diagnostics.
- A failed release preparation resumes its verified command prefix only when
  source, target, toolchain, environment, acquisition mode, and package
  identities still match.
