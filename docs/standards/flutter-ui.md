# Flutter UI implementation standard

Applies to Flutter UI work in this repository.

## Flutter Goo component guidance

For Flutter work only, treat the sibling `flutter-ui-mobile` project as the
design and implementation authority:

- Design guidance: `/Users/studio/Documents/GitHub/flutter-ui-mobile/DESIGN.md`
- Flutter development guidance: `/Users/studio/Documents/GitHub/flutter-ui-mobile/DOC.md`

Before changing UI, screens, navigation, visual states, or Flutter component usage, read and follow both files. In particular:

- Prefer exported `Goo*` components from `package:flutter_ui_mobile/flutter_ui_mobile.dart`.
- Do not invent undocumented Goo components, constructor arguments, enum values, variants, colors, shadows, motion, or surface styles.
- If the docs and the installed package API disagree, the API that imports and passes analyzer in this project wins.
- Use Goo design tokens and component variants before hand-writing Material surfaces, typography, colors, dividers, loading states, dialogs, panels, toasts, snackbars, or form controls.
- Preserve existing business behavior and platform contracts when migrating UI to Goo components.

Goo components, tokens, typography, and surface guidance do not govern the
Electron renderer.
