# Codex UI Reproduction

Standalone Flutter desktop reproduction of the UI packaged by
`Haleclipse/CodexDesktop-Rebuild` version `26.721.81911`. The renderer's
compiled CSS, component classes, and scoped SVG paths are the visual source of
truth.

The app is presentation-only. Search, settings, task navigation, menus,
tooltips, theme switching, and composer controls expose UI states without
connecting to Codex or Voice2Text business logic.

Codex-specific controls are intentional in this isolated app: the extracted
Radix/Tailwind radii, state layers, blur, and shadows cannot be expressed
exactly through the current Goo public component variants.

```bash
flutter run -d macos
```
