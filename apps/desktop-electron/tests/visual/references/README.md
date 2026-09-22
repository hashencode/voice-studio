# ReUI App Shell 4 reference authority

`reui-app-shell-4-2026-09-03-1280x720.png` is the active visual-composition reference for the Electron Renderer shell. The same-session capture also includes collapsed and mobile states. `reui-app-shell-4-render.json` pins checksums, computed-style and geometry observations, and acceptance boundaries. `reui-app-shell-4-dom-2026-09-03.json` contains the observed hierarchy, classes, bounds and selected computed properties of 298 rendered non-SVG shell elements; it is not original component source or a complete website export.

- Source: <https://reui.io/preview/base/app-shell-4>
- Captured: 2026-09-03
- Host: macOS 15.7.5 (24G624), Apple arm64
- Browser: headless Chromium 151 through agent-browser
- CSS viewport: 1280×720 at 100% zoom and device pixel ratio 1
- Theme: light
- Computed page font: `Inter, "Inter Fallback"`
- SHA-256: `157dc7bc100b4922516de8fdc60cbd470fbf6277d75a1bb46a99c25703a4a58e`

The historical `reui-app-shell-4-1280x720.png` from 2026-09-02 remains unchanged, with its checksum retained in the render record.

The pinned public reference continues to record a 390px context pane and x=440
content origin. Voice2Text now deliberately differs: its product context pane
defaults to 300px, is adjustable at runtime from 240px through 480px, shares one
requested width across the four main sections, and temporarily clamps without
overwriting that request when the window narrows. This product delta does not
alter the reference image, DOM evidence, geometry, or checksums. Authorized
rendered product acceptance and the width-sensitive golden refresh completed on
2026-09-04.

The image and render record govern the observed ReUI shell composition,
fixed-column geometry, density, divider placement, control placement and state
hierarchy. They are public-render evidence, not the current Voice2Text width
contract, the original ReUI React, or Registry source. Local `radix-nova`
primitives remain authoritative for component semantics, keyboard behavior,
focus and independently authored implementation.

Authenticated ReUI MCP discovery was attempted on 2026-09-03 and returned `locked: true` with `requiredPlan: pro`. The implementation therefore must not claim source access, bypass the premium Registry, decompile production bundles, copy the complete website stylesheet or hotlink ReUI runtime assets. The user explicitly approved using the observable public preview as the visual authority while implementing product behavior locally.

To replace this reference, deliberately recapture the same public preview at the desktop and responsive viewports recorded in `reui-app-shell-4-render.json`; refresh its DOM/style evidence and checksums; then inspect it side by side with the Electron `audio-app-shell-4.png` candidate before accepting any golden updates. A live-page change never silently replaces the pinned files.

The previous screenshot-led implementation plan remains available as superseded design history at `docs/plans/2026-09-02-1350-refactor-electron-reui-app-shell-plan.md`.

The Renderer now uses the platform system-font stack and does not bundle Inter.
The pinned ReUI reference still records Inter as observed source evidence; this
typography difference is an explicit product choice and does not alter the
reference files or checksums. No ReUI runtime asset is used. The midpoint handle
matches the observed transparent 28×48 hit area and two 2×8 strokes. Authorized
direct image inspection and regional geometry/style assertions were completed
on 2026-09-03 against the Electron product. Product content, typography, thin
focus, native handle title and desktop minimum behavior remain deliberate
differences; this is not whole-page pixel equality.
