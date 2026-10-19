# Verification standard

Applies to repository changes. The root `AGENTS.md` is the sole authority for
visual-validation permission; check that gate before selecting a UI lane below.

## Change-scoped verification policy

This is the authoritative verification policy for this project. Read it before
choosing checks; update it when test scripts or their coverage change. README
links to the policy instead of maintaining a second decision table.

- Before executing, briefly state the changed files, affected behavior and
  reverse consumers, and the selected checks. Use the actual comparison base;
  include relevant staged, unstaged, new and renamed paths. Keep unrelated WIP
  separate. A new report file is not required for every task.
- Routine work uses the smallest existing checks that prove that scope. Do not
  append a full suite merely because a task is finishing. Expand to the owning
  module/package when the impact cannot be bounded; use full source regression
  before merge, for package-wide changes, or when explicitly requested. Explain
  the reason for expansion. Release/packaged evidence retains its own gates.
- A passed check is reusable only while its relevant code, tests, configuration,
  toolchain, environment and artifact identity are unchanged. Do not run an
  equivalent alias or covered subset again. Rerun affected checks after relevant
  changes, incomplete execution or a failure needing confirmation. Report
  unrelated pre-existing failures; do not repeatedly rerun them.
- Documentation/comment-only work needs diff and reference inspection, without
  product tests, builds or GUI. Static checks and unit tests must not imply GUI,
  packaging or resource acquisition. Keep runtime, packaged and release proof
  distinct; use one fresh preparation per runtime batch, never a stale artifact.
- Bound consumers using imports and reference searches. Static import graphs
  alone miss IPC/Preload wiring, source-file reads, CSS, fixtures, configuration
  and Shell composition. Include these explicitly. A zero-test selection is
  not a pass: select the owning group or report the coverage gap.
- Layout changes cover only affected surfaces at the default and supported
  minimum size, plus both sides of a real breakpoint where applicable. Global
  styles/theme/Shell changes expand to actual consumers. Pure business changes
  do not rerun a size matrix. Keep meaningful overflow, occlusion, scrolling,
  zoom and action-reachability assertions; formal acceptance retains its matrix.
- New tests use unit coverage for pure logic, integration for changed boundaries,
  and GUI/E2E for required runtime paths. Size cases prove layout behavior rather
  than repeating whole business flows. Use existing frameworks; do not add
  tests for simple aliases or documentation that mirror the implementation.
- Report commands, scope, results and unverified parts. Skips, zero cases, old
  packages and another checkout's evidence do not count as current verification.
  Preserve test-data isolation, serial window/database checks and GUI authority.

## Verification lanes

Use the lightest lane that proves the changed behavior. Routine work must not run
the 20-stage `./tool/dev_check.sh` by default.

| Change | Required verification |
| --- | --- |
| Documentation, comments, or analysis-only work | Inspect the diff and check affected references for consistency. Do not run tests, analyzers, or builds. |
| Electron renderer behavior | Use changed-file format/lint, package typecheck and explicit relevant Vitest files plus feature/Shell consumers. These checks do not launch UI. For package-wide Renderer regression use `bun run check:ui` once; `check:ui:quick` is the same check, not an additional final gate. |
| Electron renderer layout, styling, navigation or visual states | Use the non-GUI renderer checks above; add the specific Playwright file/name cases only after explicit current-task visual authorization. Otherwise report rendered verification as unexecuted. Cover affected default/minimum/breakpoint cases, not the whole matrix by default. |
| Electron Main, Preload, shared contracts, storage, or ordinary worker integration | Use package typecheck, changed-file format/lint, explicit relevant tests and wiring/reverse consumers; include `check:boundaries` or `check:lifecycle` when those contracts are affected. Use `check:code` for full Electron source regression before merge or when impact is package-wide. |
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

## Electron selection examples

From `apps/desktop-electron`, `bun run test tests/unit/capture_quit_main_wiring_test.ts`
selects an explicit file. `bunx vitest related --run <changed-source-files>` is a
static-import aid, not a complete impact oracle; include source-reading wiring,
IPC/Preload, feature and Shell tests explicitly. `bun run typecheck` stays
package-wide. Use `bunx prettier --check <changed-files>` and
`bunx eslint <changed-source-files> --max-warnings 0` for local edits; config changes
expand their consumers. No new runner or duplicate focused alias is required.

After current-task visual authorization, use one invocation such as
`bun run test:visual tests/visual/pane-spacing-alignment.visual.spec.ts --grep 'shared 260-320-380|supported minimum window'`.
Preview the same selection with `bunx playwright test --config=playwright.config.ts tests/visual/pane-spacing-alignment.visual.spec.ts --grep 'shared 260-320-380|supported minimum window' --list`, which does not run the harness or GUI.
Retain the minimum-window clamp and independent floating-window contracts.
A matching file alone can contain many unrelated states; choose names as well.

`check:ui` aliases `check:ui:quick`; `check:code` includes the UI source tests and
static checks. Do not run those subsets again after the covering result passes
unless relevant inputs changed. Neither source gate is rendered evidence.

Policy walkthrough: docs -> references; local logic -> relevant unit/callers;
shared IPC -> boundary/wiring consumers; layout -> unit + authorized named
cases; merge -> full source gate; unchanged passing superset -> no repeat.
