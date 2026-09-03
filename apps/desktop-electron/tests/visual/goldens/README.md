# Renderer visual baseline authority

These images are canonical only for the following rendering contract:

- macOS 15.7.5 (24G624), Apple arm64
- repository-pinned Electron 43.4.0 / Chromium 150.0.7871.224
- Electron production Renderer entry with the test-only Main/Preload harness
- CSS device pixel ratio 1 and exact 1280x720, 1240x820, 880x620, or 320x96 viewport
- `zh-CN`, light color scheme, reduced motion, fixed fixture time `2026-08-19T03:20:00.000Z`
- target shell font stack `"Inter Variable", Inter, "PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif` (self-hosted Inter; the floating Renderer imports the shared stylesheet and inherits this font)

These ten baselines were inspected and refreshed during authorized visual acceptance on 2026-09-03. The final no-update visual run passed all eleven tests, including hover, selected, keyboard-focus and disabled-state assertions. The floating control retains its layout and behavior; its small timer-glyph delta reflects the shared font change.

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

The 1280×720 shell comparison uses `../references/reui-app-shell-4-2026-09-03-1280x720.png`. Direct image inspection and regional assertions check the 49px primary rail, 390px context column plus divider, x=440 content origin, aligned 50px heads, 45px search band, compact filters, midpoint rail, density, borders, and shadowless surfaces. Product content remains Voice2Text-specific. Reference Chromium 151 and product Chromium 150 are recorded separately; acceptance is not a whole-page pixel-equality claim.

When visual execution is authorized, non-macOS-arm64 hosts still execute the semantic and 0.5px-tolerance geometry assertions, but do not create or compare these canonical images. The suite checks pinned reference image and render-evidence checksums before launching sessions; checksum integrity alone does not establish visual parity.

Page errors and unexpected console errors fail the suite. The existing Chromium diagnostic about `frame-ancestors` in a meta CSP is recorded as a test annotation using an exact-message match; the unchanged CSP predates this work. Packaging and animated-transition correctness are outside this steady-state Renderer harness.
