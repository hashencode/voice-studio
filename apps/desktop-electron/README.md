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

For Renderer work, `bun run check:ui` checks formatting, lint, types, and
focused Renderer behavior without launching Electron windows. Use
`bun run check:ui:visual` only when visual acceptance is explicitly requested.
Updating canonical screenshots is a separate, deliberate action:
`bun run check:ui:visual:update`. Broader Electron code work uses
`bun run check:code`. None of these commands packages the application or
downloads frozen models. Release evidence is the explicit heavy lane:

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

`bun run check:ui:visual` launches the repository-pinned Electron runtime through a
test-only Main/Preload harness, exercises the production Renderer entry, checks
sidebar geometry, and runs seven deterministic scenarios with six canonical
screenshots, including the 320 x 96 desktop floating capture control. It also checks the 320 px compact
shell without adding a host-sensitive full-shell pixel baseline.
Canonical pixel baselines are macOS arm64 only; every host still runs the
semantic and 1 px geometry assertions. Run
`bun run check:ui:visual:update` only after an explicit baseline-update request.
Baseline updates require the environment recorded in
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

## Electron UI authority and registry provenance

Electron renderer primitives use the official shadcn `radix-nova` composite
style as their sole component and typography baseline. The value in
`components.json` selects both the Radix primitive base and the Nova visual
recipe; do not add a separate `base` field. Goo remains the Flutter-only design
authority and does not govern Electron.

The baseline was captured on 2026-08-26 with shadcn CLI `4.19.0` from upstream
commit `ee628d75dea87325735fafa7c54f5d7d7edb8774`. SHA-256 values below cover the
exact scoped registry inputs used for this alignment:

| Registry input                                      | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/v4/registry/__components__/radix-nova.tsx`    | `8a29734c52e715d25a037553d72a36291e128f191b5bf1eeeea2681734237a49` |
| `apps/v4/registry/styles/style-nova.css`            | `5d5751579c015b61e77cf0822862a43ac79f3e6fed236a17624be8e6d1ebea1d` |
| `apps/v4/registry/bases/radix/ui/dialog.tsx`        | `405b3f34f7b246755f346a85d2a3b652173e640cdc87240cb338e7ff0caba5c2` |
| `apps/v4/registry/bases/radix/ui/sheet.tsx`         | `a49f48bc2cb74757e61c3365c67217249b94c3aa5343e4fd981268d6bd343a4d` |
| `apps/v4/registry/bases/radix/ui/popover.tsx`       | `3b017fc4e2b83c8d6f06eb2d3d2a61f579237ab5c776119a16f38e72c7b3bb94` |
| `apps/v4/registry/bases/radix/ui/select.tsx`        | `5cb49aca6c6cdce00f5abd73eb23bb80e64a11eb007e9ca48b503720339cf460` |
| `apps/v4/registry/bases/radix/ui/dropdown-menu.tsx` | `94ad1090f2a378391284ba3601eebaf2dc306eba910a445ccda9fbfc94b3de9e` |
| `apps/v4/registry/bases/radix/ui/tooltip.tsx`       | `c57cef1493d49b3d8219a00c86b9966bee44165d02b84dae38475ba17f340ed3` |
| `apps/v4/registry/bases/radix/ui/checkbox.tsx`      | `e4ca0aad7ccc067a91952e93e788314af3c47bf010596580cb2d8095631fe2e8` |
| `apps/v4/registry/bases/radix/ui/switch.tsx`        | `0b5a47ed8854e7ceebdd953dfcd8139e087739473965c62295bfab4151fd74e5` |
| `apps/v4/registry/bases/radix/ui/slider.tsx`        | `f8dce9321581a47277691b8cfd639d6c5a969a5298fe72bdb75843331658f613` |
| `apps/v4/registry/bases/radix/ui/input.tsx`         | `1003f14ed890da7fcca423016d005fb7ccb52fd03a014b2135ad23cac827eb14` |
| `apps/v4/registry/bases/radix/ui/textarea.tsx`      | `b1a2ffd5205a8b991a47648c1fad506064f0db28a031cd28e4c51777d1c56aba` |
| `apps/v4/registry/bases/radix/ui/card.tsx`          | `f1d43a32fd28a23f187fd867d00d3117ccaf4ed5c7784a6c0030cb227789308f` |
| `apps/v4/registry/bases/radix/ui/item.tsx`          | `027729e7dfc29f1b19fde6766f992241575d956ef96e2890888bee1c62f17823` |

For an upstream refresh, use that pinned CLI to inspect project metadata, then
request a diff for only the component being changed (replace `sheet` below with
the scoped component):

```bash
npx --yes shadcn@4.19.0 info
npx --yes shadcn@4.19.0 add sheet --diff
```

Compare the diff with the pinned Radix component file and Nova style input
above, then manually merge the load-bearing structure and state classes.
Preserve local accessibility, value forwarding, controlled-state behavior,
keyboard/focus behavior, callbacks, and business layout. Never regenerate or
overwrite the local UI directory, and never import `style-nova.css`; flatten
only the scoped Nova classes the local primitive needs.

Electron intentionally differs from the official recipe in three places:
surfaces are shadowless, focus-visible indicators are thin, and modal overlays
retain the current Dialog baseline (`bg-black/10` plus
`supports-backdrop-filter:backdrop-blur-xs`). Dialog content remains shadowless
and its close action remains a ghost icon button.

| State contract | Applies to                                      | Local contract                                                                                                     |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| open / closed  | overlays and anchored surfaces                  | Preserve Radix `data-state`, portal, Escape, and focus restoration semantics; animations must remain state-driven. |
| hover          | actionable triggers, items, and close buttons   | Use the Nova interaction surface; Dialog close keeps the ghost hover treatment.                                    |
| focus-visible  | keyboard-operable controls                      | Keep a visible, thin indicator; do not replace it with a thick ring or glow.                                       |
| disabled       | controls and selectable items                   | Preserve native/Radix disabled semantics as well as the visual state.                                              |
| invalid        | inputs, textareas, and applicable form controls | Drive styling from `aria-invalid` without weakening the accessibility contract.                                    |
| readOnly       | text inputs and textareas                       | Remain readable and focusable where native behavior allows, without appearing editable.                            |
| dark tokens    | all surfaces and text                           | Use semantic theme tokens; the documented Dialog mask is the only fixed modal-mask baseline.                       |
| reduced motion | animated overlays and controls                  | Retain `motion-reduce` fallbacks without changing open/closed behavior.                                            |

Tests should lock these load-bearing classes and semantics, not entire generated
class strings. Static and DOM checks do not establish screenshot-level parity.
Do not run `check:ui:quick`, `check:ui`, browser/Electron-driven checks, or update
goldens without explicit task-local visual-validation authorization.

Capture has three deliberately separate presentations backed by the same Main
authority: detailed setup/recovery/captions in the third-column workspace, a
privacy-safe compact controller in the global inset header, and an optional
320 px desktop floating controller. The floating controller defaults off and
can be enabled in Settings or capture details. It uses its own sandboxed
Renderer and minimal Preload; its snapshot excludes titles, transcript text,
paths, raw errors, activity, recovery, AI, import, and export data.
