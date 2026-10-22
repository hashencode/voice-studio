# Flutter UI implementation standard

Applies to Flutter UI work in this repository.

## Flutter Goo component guidance

For Flutter work only, treat the sibling `flutter-ui-mobile` project as the
design and implementation authority:

- Design guidance: [DESIGN.md](../../../flutter-ui-mobile/DESIGN.md)
- Flutter development guidance: [DOC.md](../../../flutter-ui-mobile/DOC.md)

Repository: [flutter-ui-mobile](https://github.com/hashencode/flutter-ui-mobile.git). Its usual location is `../flutter-ui-mobile` relative to the Voice Studio root; the mobile app's actual path dependency is declared in `apps/mobile-flutter/pubspec.yaml`.

For Flutter UI work, check the local repository identity and the dependency version before reading these files. If the checkout, required file or matching version is missing, tell the user why the task needs it, the repository URL, expected location and required version, and ask them to obtain the source. Pause only the dependent part; do not switch another task's branch. Electron-only work and documentation unrelated to component behavior do not require this checkout. Historical evidence uses the recorded revision rather than the latest working tree.

Before changing UI, screens, navigation, visual states, or Flutter component usage, read and follow both files. In particular:

- Prefer exported `Goo*` components from `package:flutter_ui_mobile/flutter_ui_mobile.dart`.
- Do not invent undocumented Goo components, constructor arguments, enum values, variants, colors, shadows, motion, or surface styles.
- If the docs and the installed package API disagree, the API that imports and passes analyzer in this project wins.
- Use Goo design tokens and component variants before hand-writing Material surfaces, typography, colors, dividers, loading states, dialogs, panels, toasts, snackbars, or form controls.
- Preserve existing business behavior and platform contracts when migrating UI to Goo components.

Goo components, tokens, typography, and surface guidance do not govern the
Electron renderer.
