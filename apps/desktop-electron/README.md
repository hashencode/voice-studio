# Voice2Text Electron desktop

This is the independent Electron desktop composition root. It uses Bun,
Electron Forge, Vite, React/TypeScript, Tailwind, and the pinned shadcn
`sidebar-09` composition. Flutter Desktop remains frozen reference source only;
this application does not open its profile, import its packages, or use it as a
runtime fallback.

## Development

```bash
bun ci
bun run resources:worker
bun run check:ui
bun run check:code
bun run start
```

`bun run resources:worker` is required on the first checkout and whenever the
frozen worker/model resources change. Later development runs can use
`bun run start` directly.

During active Renderer iteration, use `bun run check:ui:quick`; it checks
formatting, lint, types, and focused Renderer behavior. `bun run check:ui:quick`
does not launch Electron windows. Once the UI edit is stable, run
`bun run check:ui` once for the final visual scenarios and screenshots. Broader
Electron code work uses `bun run check:code`. None of these commands packages
the application or downloads frozen models. Release evidence is the explicit
heavy lane:

```bash
VOICE2TEXT_RELEASE_VALIDATION=1 bun run check:release
```

That lane runs package-once candidate preparation. If a later automated gate
fails, `.prepare-state.json` records the exact successful prefix and package
identity. A retry resumes only while source, target, toolchain, relevant
environment, acquisition mode, command matrix, and package hashes still match.
The checkpoint is internal state and is removed after the candidate and pending
manual receipts are recoverable. For candidate recovery diagnostics, the direct
runner remains `python3 ../../tool/audio_sidebar_release_candidate.py prepare`.

`bun run package` builds the existing Dart/native desktop worker and its dynamic
libraries into `resources/worker`, then packages them outside `app.asar`.
`bun run smoke:package` launches the packaged macOS app from the system temporary
directory and verifies the real worker health handshake.

`bun run test:visual` launches the repository-pinned Electron runtime through a
test-only Main/Preload harness, exercises the production Renderer entry, checks
sidebar geometry, and runs seven deterministic scenarios with six canonical
screenshots, including the 320 x 96 desktop floating capture control. It also checks the 320 px compact
shell without adding a host-sensitive full-shell pixel baseline.
Canonical pixel baselines are macOS arm64 only; every host still runs the
semantic and 1 px geometry assertions. Baseline updates require the environment recorded in
`tests/visual/goldens/README.md` and a side-by-side review against the pinned
official `sidebar-09` demo.

## Frozen resource cache

Verified source archives are reused across worktrees from
`${HOME}/Library/Caches/Voice2Text/resource-downloads-v1`. Objects are keyed by
their frozen SHA-256, rehashed on every use, snapshotted into private per-run
staging, and pruned oldest-first under a 4 GiB retained-cache ceiling. The build
fails before downloading when the configured ceiling cannot hold the protected
working set.

- `VOICE2TEXT_RESOURCE_CACHE_DIR=/path` changes the shared cache location.
- `VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB=6` changes its retained size ceiling.
- `VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD=1` replaces every required object
  from its frozen source and is appropriate for an explicitly requested fresh
  release proof.

Normal cleanup removes only disposable extraction staging. Do not delete the
shared cache between plans or worktrees.

The Renderer is sandboxed and has no Node or Electron imports. Privileged work
is exposed through the fixed API in `src/preload`, validated in Main, and backed
by versioned serializable contracts in `src/shared`.

Capture has three deliberately separate presentations backed by the same Main
authority: detailed setup/recovery/captions in the third-column workspace, a
privacy-safe compact controller in the global inset header, and an optional
320 px desktop floating controller. The floating controller defaults off and
can be enabled in Settings or capture details. It uses its own sandboxed
Renderer and minimal Preload; its snapshot excludes titles, transcript text,
paths, raw errors, activity, recovery, AI, import, and export data.
