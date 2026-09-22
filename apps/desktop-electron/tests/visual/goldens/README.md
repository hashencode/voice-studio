# Renderer visual baseline authority

The audio first-use top bar is intentionally omitted. The two
`audio-empty-recording-ready*.png` baselines record that full-page presentation.

The product shell defaults its context pane to 300px and supports runtime
resizing from 240px through 480px while retaining at least 480px for main
content. The width-sensitive product PNGs below record the 300px default; the
behavioral visual test separately covers drag, viewport clamping, four-section
sharing, collapse-control isolation, and reload reset.

These images are canonical only for the following rendering contract:

- macOS 15.7.5 (24G624), Apple arm64
- repository-pinned Electron 43.4.0 / Chromium 150.0.7871.224
- Electron production Renderer entry with the test-only Main/Preload harness
- CSS device pixel ratio 1 and exact 1280x720, 1240x820, 880x620, or 320x96 viewport
- `zh-CN`, light color scheme, reduced motion, fixed fixture time `2026-08-19T03:20:00.000Z`
- captured shell font stack `"Inter Variable", Inter, "PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif` (self-hosted Inter; the floating Renderer imported the shared stylesheet and inherited this font)

These ten baselines were inspected during authorized visual acceptance on
2026-09-04. Nine width- or full-page-sensitive images were refreshed; the
floating control remained unchanged. The final no-update run passed all twelve
tests, including the runtime resize contract, hover, selected, keyboard-focus,
disabled-state, and reference-integrity assertions.

The Renderer switched from bundled Inter to the system-font stack after that
acceptance run. The PNG baselines remain the last authorized captures and need
an authorized refresh before they can establish the current typography.

The shell baselines are:

- `audio-app-shell-4.png` (1280×720 accepted shared-chrome comparison)
- `audio-open-selected-active-capture.png`
- `audio-pane-closed.png`
- `audio-empty-recording-ready.png`
- `audio-empty-recording-ready-minimum.png`
- `activity-messages.png`
- `settings.png`
- `audio-overlay-capture-recovery.png`
- `companion-multiple-devices.png`
- `floating-capture-recording.png`

The 1280×720 shell comparison uses
`../references/reui-app-shell-4-2026-09-03-1280x720.png`. Its 390px context
column and x=440 content origin remain historical public-reference evidence,
not current Voice2Text product geometry. Current product assertions target a
49px primary rail, 300px default context pane plus 1px divider, x=350 content
origin, aligned heads, compact controls, borders, and shadowless surfaces.
Reference Chromium 151 and product Chromium 150 are recorded separately;
acceptance is not a whole-page pixel-equality claim.

When visual execution is authorized, non-macOS-arm64 hosts still execute the semantic and 0.5px-tolerance geometry assertions, but do not create or compare these canonical images. The suite checks pinned reference image and render-evidence checksums before launching sessions; checksum integrity alone does not establish visual parity.

Page errors and unexpected console errors fail the suite. The existing Chromium diagnostic about `frame-ancestors` in a meta CSP is recorded as a test annotation using an exact-message match; the unchanged CSP predates this work. Packaging and animated-transition correctness are outside this steady-state Renderer harness.
