# ReUI App Shell 4 reference authority

`reui-app-shell-4-1280x720.png` is the immutable visual-composition reference for the Electron Renderer shell. `reui-app-shell-4-render.json` records the matching public-render DOM, computed-style, geometry and state evidence.

- Source: <https://reui.io/preview/base/app-shell-4>
- Captured: 2026-09-02
- Host: macOS 15.7.5 (24G624), Apple arm64
- Browser: Codex in-app Chromium browser (runtime version is not exposed by the capture surface)
- CSS viewport: 1280×720 at 100% zoom and device pixel ratio 1
- Theme: light
- Computed page font: `Inter, "Inter Fallback"`
- SHA-256: `cf275b5f8dfd390bce85529b00ed4b1b67993bb2b906944e8fce06be9fcf798f`

The image and render record govern observable shell composition, fixed-column geometry, density, divider placement, control placement and state hierarchy. They are public-render evidence, not the original ReUI React or Registry source. Local `radix-nova` primitives remain authoritative for component semantics, keyboard behavior, focus and independently authored implementation.

Authenticated ReUI MCP discovery was attempted on 2026-09-03 and returned `locked: true` with `requiredPlan: pro`. The implementation therefore must not claim source access, bypass the premium Registry, decompile production bundles, copy the complete website stylesheet or hotlink ReUI runtime assets. The user explicitly approved using the observable public preview as the visual authority while implementing product behavior locally.

To replace this reference, deliberately recapture the same public preview at the desktop and responsive viewports recorded in `reui-app-shell-4-render.json`; refresh its DOM/style evidence and checksums; then inspect it side by side with the Electron `audio-app-shell-4.png` candidate before accepting any golden updates. A live-page change never silently replaces the pinned files.

The previous screenshot-led implementation plan remains available as superseded design history at `docs/plans/2026-09-02-1350-refactor-electron-reui-app-shell-plan.md`.
