---
title: Empty-state component scope must not implicitly control Shell chrome
date: 2026-09-16
category: logic-errors
module: apps/desktop-electron renderer
problem_type: ui_bug
component: frontend
symptoms:
  - The populated-but-unselected Audio Workspace correctly renders a local EmptyState but unexpectedly restores the Shell Header.
  - The same state unexpectedly receives compact outer padding even though the established layout keeps outer padding at none.
  - The left audio list remains present, so the screen is not a full-screen empty state despite still suppressing Shell chrome.
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - empty-state
  - shell-chrome
  - audio-workspace
  - component-classification
  - layout-regression
  - renderer-ui
---

# Empty-state component scope must not implicitly control Shell chrome

## Problem

An empty-state component migration changed more than the component taxonomy. The populated-but-unselected audio workspace was supposed to remain a local empty state, but treating “not full-screen” as equivalent to “ordinary workspace chrome” also restored the top Header and compact content padding. Those Shell changes were outside the requested scope.

Three UI dimensions are independent:

1. **Component taxonomy** — whether the view uses `EmptyState` or `FullScreenEmptyState`.
2. **Content scope** — whether the empty state occupies a local column or the whole workspace.
3. **Shell chrome policy** — whether the Header, outer padding, side pane, and other surrounding layout are visible.

The audio selection prompt demonstrates the intended combination: it renders a description-only local `EmptyState` (`apps/desktop-electron/src/renderer/features/audios/audio-route-feature.tsx:1792-1793`), while the Shell independently hides the Header and removes outer padding for that state (`apps/desktop-electron/src/renderer/App.tsx:683-697`, `apps/desktop-electron/src/renderer/App.tsx:851`).

## Symptoms

- The local prompt “请选择左侧音频” remained visible, but the Shell Header was also visible.
- The content container received ordinary audio-workspace padding instead of remaining unpadded.
- The left audio context pane still existed, so the state was local even though it required special Shell treatment.

The regression tests encode the correct observable behavior: the audio pane remains present, the inset Header is absent, and the main content has neither `p-4` nor `sm:p-6` (`apps/desktop-electron/tests/unit/renderer/shell_test.tsx:1079-1085`, `apps/desktop-electron/tests/unit/renderer/shell_test.tsx:1165-1170`).

## What Didn't Work

The faulty reasoning can be abstracted as coupling Shell behavior directly to component classification:

```text
fullScreenEmpty = firstUse || noSelection || noMessages

// After noSelection migrates to a local EmptyState:
fullScreenEmpty = firstUse || noMessages

showHeader = !fullScreenEmpty
contentPadding = fullScreenEmpty ? none : compact
```

Removing `noSelection` from `fullScreenEmpty` was correct for component taxonomy, but using the same flag to govern Shell chrome silently changed two additional behaviors. Component names are not a sufficient policy API for surrounding layout.

Route tests that only verify the selected component cannot catch this regression. The route test verifies that the prompt uses the local empty-state slot, has no heading, and has no full-screen preview (`apps/desktop-electron/tests/unit/renderer/audio_route_test.tsx:810-830`), but Shell behavior requires separate coverage.

## Solution

Keep component classification and Shell chrome suppression as separate predicates:

```text
audioSelectionEmpty =
  isAudioWorkspace && libraryIsPopulated && noAudioSelected

fullScreenEmpty = audioFirstUse || messageEmpty

emptyPresentationHidesChrome =
  fullScreenEmpty || audioSelectionEmpty

showHeader = !emptyPresentationHidesChrome && !audioDetail
contentPadding = emptyPresentationHidesChrome ? none : workspaceDefault
```

The renderer now identifies the populated-but-unselected state separately, keeps `fullScreenEmptyPresentation` limited to true full-screen states, and uses `emptyPresentationHidesChrome` for the independent Header and padding decision (`apps/desktop-electron/src/renderer/App.tsx:683-697`, `apps/desktop-electron/src/renderer/App.tsx:851`).

The local prompt remains deliberately small:

```tsx
function AudioSelectionPrompt() {
  return <EmptyState description="请选择左侧音频" className="flex-1" />;
}
```

## Why This Works

The predicates model product behavior directly instead of deriving unrelated decisions from a component name:

- `fullScreenEmptyPresentation` classifies truly full-screen empty states.
- `audioSelectionEmptyPresentation` identifies a local state with special Shell treatment.
- `emptyPresentationHidesChrome` answers the separate Header and padding question.

This permits the required combination: a local empty state can hide the Header and outer padding while retaining its left context pane. The separation allows each local empty state's Shell policy to be chosen independently without distorting the component taxonomy.

The tests protect both boundaries. Route assertions verify the component contract (`apps/desktop-electron/tests/unit/renderer/audio_route_test.tsx:810-830`); Shell assertions verify the Header, padding, and pane contract (`apps/desktop-electron/tests/unit/renderer/shell_test.tsx:1079-1085`, `apps/desktop-electron/tests/unit/renderer/shell_test.tsx:1165-1170`).

## Prevention

Treat component migrations as behavior-preserving by default. Before changing an empty-state primitive, record each independent dimension:

| Dimension | Populated library, no selection |
| --- | --- |
| Component | Local `EmptyState` |
| Copy | Description only: “请选择左侧音频” |
| Header | Hidden |
| Outer padding | None |
| Left audio pane | Visible |

Cover both layers in tests:

- Feature-level assertions verify the local/full-screen primitive, heading, description, and feature-owned actions.
- Shell-level assertions verify the Header, outer padding, context panes, focus, and navigation that must remain invariant.

During review, every changed Header, padding, side-pane, copy, focus, or navigation behavior must map to an explicit current requirement. If a migration request names only the empty-state component, every other behavior remains invariant unless separately approved.

## Related Issues

- [Desktop-first workstation boundaries](../architecture-patterns/desktop-first-workstation-boundaries.md) provides the broader Electron composition-boundary context.
