# Desktop client transition

## Status

Accepted on 2026-08-14. This decision refines the existing
`MONOREPO_KEEP_ROOT_MOBILE` repository strategy; it does not split the product
into a second repository.

## Decision

The repository will temporarily contain two desktop client locations:

- `apps/desktop` remains the current Flutter desktop implementation, behavioral
  reference, and retained evidence source. It is not a runtime fallback and is
  not launched by the Electron migration.
- `apps/desktop-electron` is the replacement Electron desktop client and owns an
  independent runtime profile.

The existing Flutter directory is not renamed during the transition because
build scripts, validators, benchmark evidence, and product documentation already
refer to `apps/desktop`.

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
- During migration, `apps/desktop` receives compatibility, security, and
  reference-blocking fixes. New desktop product work should avoid unnecessary
  dual implementation unless it is required to keep the reference usable.

## Flutter removal gate

`apps/desktop` can be removed only after the Electron client has all of the
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

Removal is a separate reviewed change. It must delete Flutter-only desktop
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
outside it. Windows begins only after macOS closure and must produce independent
target evidence. A macOS result never transfers to Windows.

Until both supported targets pass independently, the Flutter removal gate is
closed. A blocked Electron result preserves `apps/desktop` as reference source
and does not authorize launching it, opening its runtime profile, sharing its
database, or using it as a fallback.
