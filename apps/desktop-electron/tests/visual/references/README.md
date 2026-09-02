# ReUI App Shell 4 reference authority

`reui-app-shell-4-1280x720.png` is the immutable visual-composition reference for the Electron Renderer shell.

- Source: <https://reui.io/preview/base/app-shell-4>
- Captured: 2026-09-02
- Host: macOS 15.7.5 (24G624), Apple arm64
- Browser: Codex in-app Chromium browser (runtime version is not exposed by the capture surface)
- CSS viewport: 1280×720 at 100% zoom and device pixel ratio 1
- Theme: light
- Computed page font: `Inter, "Inter Fallback"`
- SHA-256: `cf275b5f8dfd390bce85529b00ed4b1b67993bb2b906944e8fce06be9fcf798f`

The image governs shell composition, fixed-column geometry, density, divider placement, and control placement. Local `radix-nova` primitives remain authoritative for component semantics, keyboard behavior, focus, and typography implementation.

To replace this reference, deliberately recapture the same source at the same CSS viewport, zoom, DPR, and light theme; record the new environment and checksum here; then inspect it side by side with the Electron `audio-app-shell-4.png` candidate before accepting any golden updates. The live page is supplemental evidence and never silently replaces this file.
