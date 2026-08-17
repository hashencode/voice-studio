# Desktop client transition

## Status

Accepted on 2026-08-14 and closed on 2026-08-17. This decision refines the
existing `MONOREPO_KEEP_ROOT_MOBILE` repository strategy; it does not split the
product into a second repository.

## Decision

`apps/desktop-electron` is the only supported desktop composition root. The
Flutter Desktop composition root was retired through U14 after the packaged
macOS Electron gate passed. Frozen Flutter behavior sources remain inert,
hash-bound fixtures under
`apps/desktop-electron/tests/fixtures/flutter-reference/source/`; they are not
an application, runtime fallback, or shared profile.

## Boundaries

- The Electron client must be an independent application composition root. It
  must not import the Flutter desktop application.
- Electron and Dart keep separate dependency graphs, lockfiles, build commands,
  and targeted CI checks even though they share one Git repository.
- Cross-language reuse happens through versioned, language-neutral process
  contracts and compiled Dart/native workers. Flutter widgets and Dart-only
  application services are reference material, not Electron dependencies.
- Existing target-specific model, runtime, benchmark, privacy, cancellation,
  recovery, and artifact-integrity evidence remains authoritative until the
  Electron client produces equivalent evidence for its own packaged artifacts.
- Flutter reference material is historical evidence only. Active build, test,
  benchmark, and packaging commands must not depend on the retired source root.

## Flutter removal gate

The completed U14 removal gate required the Electron client to have all of the
following:

1. An approved capability-parity matrix covering the desktop product flows.
2. Verified forward migration for Electron-created data. Electron does not
   detect, open, copy, migrate, or fall back to a Flutter Desktop profile.
3. Equivalent worker lifecycle behavior, including progress, cancellation,
   crash recovery, temporary-file cleanup, and fail-closed result publication.
4. Target-specific ASR quality, performance, resource, and packaging evidence.
5. Passing desktop integration, privacy, security, accessibility, signing, and
   update checks for every supported target.
6. A real-user or release-candidate validation showing that Flutter reference
   source is no longer required for critical-work parity evidence.

Removal is a separate reviewed change. It deletes Flutter-only desktop
build wiring and documentation without deleting shared contracts, workers,
fixtures, benchmarks, or retained historical evidence.

## Target closure gate

Electron target closure is recorded in
`docs/product/desktop-electron-scope.json` and validated by
`tool/validate_electron_desktop_scope.py`. A target can claim `PASS` only when
its evidence binds the current source revision, dependency lock, packaged app,
native helper, workers, runtimes, models, fixtures, signing result, target
fingerprint, product-flow checks, privacy scan, and accessibility checks.

The active macOS gate remains `DEVELOPMENT_ONLY`; notarization, automatic
updates, store submission, and a release-candidate device matrix are explicitly
outside it. On 2026-08-17 the user explicitly set the current supported desktop
target to macOS only. Windows/U13 is `DEFERRED_OUT_OF_CURRENT_SCOPE`: it has no
PASS, evidence, or inherited macOS result and may be reopened only as an
independent future target. The scope decision does not authorize launching,
opening, copying, or cleaning any historical Flutter runtime profile.
