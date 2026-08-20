# Renderer visual baseline authority

These images are canonical only for the following rendering contract:

- macOS 15.7.5 (24G624), Apple arm64
- repository-pinned Electron 43.4.0 / Chromium 150.0.7871.224
- Electron production Renderer entry with the test-only Main/Preload harness
- CSS device pixel ratio 1 and exact 1240x820, 880x620, or 320x96 viewport
- `zh-CN`, light color scheme, reduced motion, fixed fixture time `2026-08-19T03:20:00.000Z`
- declared font stack `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif`

The six baselines are:

- `audio-open-selected-active-capture.png`
- `audio-pane-closed.png`
- `settings.png`
- `audio-overlay-capture-recovery.png`
- `companion-multiple-devices.png`
- `floating-capture-recording.png`

Non-macOS-arm64 hosts still execute the semantic and 1px-tolerance geometry assertions, but do not create or compare these canonical images.
