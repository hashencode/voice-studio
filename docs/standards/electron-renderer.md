# Electron renderer standard

Applies to Electron renderer components, features, and Shell layout.

Read this document before editing `apps/desktop-electron/src/renderer/` or its
renderer-facing tests. The current local primitive APIs and an explicit current
product requirement take precedence over historical plans and screenshots.

## Third-column layout

- The Shell's main inset occupies the viewport width remaining after the
  navigation rail and context pane. Keep the existing context-pane drag limits
  and the main content minimum; do not add a second width state for the inset.
- A page-level third-column canvas uses the available width (`w-full min-w-0`)
  with its established outer padding. Do not center and cap the entire page with
  `max-w-*` when the user expands the column.
- Limit width locally where the content needs it: long prose, transcript text,
  and compact controls can have their own readable measure. Independent cards
  or setting groups may form responsive columns when their order and behavior
  remain clear; narrow widths must fall back to one column without horizontal
  overflow.
- Preserve page-owned edge-to-edge content, sticky headers and footers, and
  Shell decisions for Header visibility, outer padding, context panes, focus,
  navigation, and empty states. A width change alone does not change those
  policies.
- Document a page-level width exception next to its owning page and explain
  the content need; do not impose it on the shared third-column Shell.

## Electron renderer component guidance

- Treat the official shadcn `radix-nova` recipe as the component and typography
  authority for Electron renderer primitives. Keep the existing Radix APIs,
  controlled state, keyboard behavior, focus restoration, and callbacks.
- Merge only the scoped official Radix component diff and the required Nova
  recipe classes into local primitives. Never overwrite a customized component
  wholesale or import the full Nova preset stylesheet.
- Electron owns exactly these visual exceptions: shadowless surfaces, a thin
  keyboard focus indicator, and the current Dialog modal mask
  (`bg-black/10` with `supports-backdrop-filter:backdrop-blur-xs`).
- Shared primitives own decorative defaults. Renderer consumers may override
  layout such as width, direction, alignment, and contextual density, but must
  not duplicate surface, radius, shadow, or interaction-state styling.
- Treat empty-state primitive selection, occupied content scope, and Shell
  chrome policy as independent decisions. Migrating between `EmptyState` and
  `FullScreenEmptyState` must not implicitly change the Header, outer content
  padding, context panes, copy, actions, focus, or navigation.
- In linked multi-column interfaces, express one underlying absence once in
  the column that owns it. Dependent columns stay blank and omit their Header
  when they have no content; a distinct state such as data existing without a
  selection may use its own local Empty State.
- Preserve those surrounding behaviors during component migrations unless an
  explicit current requirement changes them, and protect intentional behavior
  at both the feature-component and Shell boundaries. See
  `docs/solutions/logic-errors/separate-empty-state-component-scope-from-shell-chrome.md`.

## Electron accessibility guidance

- Use the local shadcn components and their existing Radix primitives as the
  default authority for standard roles, keyboard interaction, modal focus
  containment, and ordinary trigger focus restoration. Preserve those APIs and
  behaviors instead of reimplementing them in feature code.
- Renderer features still own meaningful visible text, accessible names for
  icon-only controls, labels for form controls, Dialog titles, and concise
  descriptions. Prefer native HTML semantics and existing primitive parts
  before adding ARIA attributes or custom keyboard handlers.
- Historical plans, tests, accepted review comments, and release evidence are
  context only. None independently establishes a current Electron product
  requirement or justifies retaining custom accessibility behavior.
- Every new custom accessibility protocol must cite either a current explicit
  product requirement or a reproducible gap in the composed native HTML or
  local shadcn/Radix component. A review suggestion or a hypothetical
  assistive-technology benefit is not sufficient evidence by itself.
- Do not add hidden live regions, duplicate `role="status"` / `role="alert"`
  announcements, global announcers, or multi-state screen-reader protocols when
  the same decision-relevant state is already conveyed by the current title,
  description, visible status, or focused control.
- Override Radix open/close autofocus only when its default target is invalid or
  no longer exists, such as after deleting the trigger or completing a route
  transition. Keep the fallback local and deterministic; do not create a global
  focus state machine for a feature-level problem.
- Accessibility fixes must not silently expand into unrelated navigation,
  layout, styling, copy, component migration, or cross-platform work. Audit and
  remove historical custom behavior only when current code evidence shows that
  it duplicates primitives, has no remaining product requirement, or causes a
  concrete regression.
- Test application-owned semantics and deliberate deviations at the nearest
  stable interaction boundary. Do not duplicate the primitive library's full
  accessibility test suite or require assistive-technology/visual execution
  without the explicit authorization required by root `AGENTS.md`.
