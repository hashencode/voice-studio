---
title: Electron Sidebar-09 Fidelity and Capture Surfaces - Plan
type: refactor
date: 2026-08-19
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Electron Sidebar-09 Fidelity and Capture Surfaces - Plan

## Goal Capsule

- **Objective:** Make the Electron workstation visibly faithful to the official shadcn new-york-v4/sidebar-09, reduce unnecessary card segmentation, and replace the oversized bottom-right capture card with a concise cross-page recording experience that remains useful when the main window is not foregrounded.
- **Means:** Correct application composition against a pinned official block, define an explicit surface hierarchy, project one Main-owned capture state into an in-app top-right controller and an optional desktop floating controller, and move setup, recovery, and diagnostics into the third column. (KTD1-KTD10)
- **Authority:** This Product Contract governs Voice2Text behavior. Pinned shadcn sources govern shell composition and component geometry. Electron Main and DesktopCaptureService remain the capture and window-lifecycle authority. Existing durable capture contracts govern sleep, Renderer loss, quit, recovery, and commit semantics.
- **Execution profile:** Changes span apps/desktop-electron Renderer, Main, Preload, shared contracts, visual harness, documentation, and workstation release evidence. Flutter/Goo is outside this plan.
- **Tail ownership:** Implementation owns focused tests, deterministic visual evidence, multi-window lifecycle checks, documentation, candidate invalidation, and revalidation of one clean packaged candidate.
- **Stop conditions:** Stop for product direction if implementation requires a second capture state machine, automatic stopping when a view closes, sensitive meeting content in the floating window, a persistent notification inbox, global OS shortcuts, or changes to native capture semantics.

---

## Product Contract

### Summary

The Electron workstation retains Voice2Text navigation and workflows while adopting the official sidebar-09 structure and visual grammar. Buttons, icons, sizes, spacing, focus states, and nested Sidebar composition are verified at the application layer, where current divergence was introduced.

The current bottom-right capture card becomes one application-owned recording experience with two concise presentations:

1. A top-right in-app controller while the main window is foregrounded.
2. An optional always-on-top desktop controller while recording continues and the user works outside the main window.

Only one presentation is prominent at a time. The third column owns setup, microphone and caption choices, detailed status, recovery, and errors. A separate top-right activity entry shows capture completion or failure events without becoming another task controller.

### Problem Frame

The current implementation contains the right primitive in several places but overrides it in composition. SidebarTrigger already uses PanelLeftIcon, while ContextPaneTrigger wraps a generic button around Unicode ‹/›. Rail actions use SidebarMenuButton but override its official 32px geometry with size-10. Similar application-level substitutions repeat across buttons, controls, and surfaces. Having official code available did not produce official fidelity because it was treated as a loose reference, while tests checked behavior rather than component identity, geometry, or screenshots.

The page also uses card boundaries as its default organization method. The dominant issue is not the raw number of shadow declarations; it is that nested borders, rounded containers, and local shadows repeatedly restate hierarchy that spacing, headings, separators, selection state, and one parent surface should express.

CaptureWorkspace currently combines setup, preflight, active recording, paused state, optimistic commands, recovery, errors, and busy messages in one fixed right-4 bottom-4 w-96 shadow-lg card. Moving that same card to the top right would preserve the problem. The component must be decomposed into a shared controller/presentation model and purpose-specific surfaces.

### Key Decisions

- **Use the official block as visual and composition authority.** Preserve Voice2Text content, but reproduce the pinned block's nested Sidebar structure, control sizes, icon grammar, and flat second-column treatment. (session-settled: user-directed — chosen over a concept-only imitation: the user identified repeated button and icon mismatches despite having official code.) Governs R1-R20.
- **Use one compact capture controller with two presentations.** Show the in-app top-right form when the main window is foregrounded and an optional desktop floating form when the user works elsewhere; do not run two independent controllers or keep both prominent. (session-settled: user-approved — chosen over either a bottom-right all-in-one card or a floating-window-only design: both contexts are useful when they share one concise interaction model.) Governs R21-R32.
- **Keep capture details in the third column.** Setup, input selection, caption settings, diagnostics, detailed errors, and recovery management do not belong in the compact controller. (session-settled: user-directed — chosen over continuing to place the full workflow in a floating card: the current card is visibly overloaded.) Governs R23-R25, R32.
- **Separate ongoing control from global messages.** The compact controller owns the active recording; a top-right activity entry owns terminal completion/failure events and links back to details. (session-settled: user-approved — chosen over treating every message as another bottom-right overlay: the user wanted a dedicated global message list.) Governs R33-R35.
- **Reduce cards by information hierarchy, not by banning containers.** In-flow content defaults to flat sections and rows; cards remain for genuinely independent objects, alerts, dialogs, popovers, and the desktop floating controller. (session-settled: user-directed — chosen over widespread card segmentation: the user identified that cards currently divide almost every part of the page.) Governs R17-R20, R36-R38.
- **Require visual and lifecycle evidence.** Completion requires deterministic screenshots, geometry assertions, state-transition tests, and packaged multi-window checks in addition to semantic UI tests. (session-settled: user-approved — chosen over behavior-only acceptance: existing tests allowed the reported visual mismatch.) Governs R39-R48.

### Requirements

**Pinned authority and shell geometry**

- R1. Bind the correction to shadcn-ui commit 25be24cca34d06eed29a4779c3f48c4816aa812c, including its sidebar-09 page, composition, Sidebar primitive, and registry manifest.
- R2. Keep components.json at style: new-york; treat new-york-v4 as the resolved Tailwind v4 registry path rather than a persisted style value.
- R3. Use one SidebarProvider, one outer icon-collapsible Sidebar, one nested icon Sidebar, one nested context Sidebar, and one sibling SidebarInset.
- R4. The rail uses the official 3rem content width and 32px default menu-button geometry. Application code must not override default rail actions to 40px without a documented exception.
- R5. The rail retains exactly 音频, 互联, 设置 in that order. The application mark stays in SidebarHeader; Settings stays in SidebarFooter.
- R6. SidebarInset is the only main landmark. Its sticky bordered header retains the context trigger, route title, offline state, compact capture controller, and global activity entry.
- R7. The context-pane trigger uses the official Sidebar trigger geometry and PanelLeftIcon grammar while controlling Voice2Text's independent pane state. Raw Unicode arrows are prohibited for visible control icons.
- R8. At widths of at least 1024px, an open Audio or Companion pane produces a 350px total sidebar and pushes SidebarInset; a closed pane or Settings leaves only the icon rail.
- R9. At 880–1023px, an open context pane begins after the rail as a non-modal overlay while SidebarInset is not pushed. The 880px minimum window remains unchanged.

**Pane state and second-column content**

- R10. voice2text.shell.context-panes.v1 remains the only persistent authority for independent Audio and Companion pane preferences.
- R11. Resize and route changes do not write pane preference. Only explicit toggle, close, Escape, and designated background dismissal may update it.
- R12. The official Sidebar cookie and Meta/Ctrl+B shortcut must not become a second state authority or new visible behavior for this workstation.
- R13. Explicit dismissal restores focus to the active pane trigger. Child actions, search, selection, retry, import, pairing, and capture controls do not dismiss the overlay.
- R14. Audio and Companion panes use SidebarHeader, SidebarInput where applicable, SidebarContent, SidebarGroup, and full-width rows separated by borders rather than independent rounded cards.
- R15. Audio preserves loading, error/retry, empty, search-empty, list, selected, processing, record, and import states. Companion preserves loading, error, no-device, multiple-device, selected-device, and pairing states.
- R16. Do not import demo mail data, unread behavior, account controls, or features that do not already exist in Voice2Text.

**Controls, cards, and shadows**

- R17. Add only current shadcn primitives required by concrete surfaces, including Label, Switch, Select, Slider, Checkbox, and Progress; add Textarea, Card, Badge, Alert, Dialog, Popover, or ScrollArea only where their semantics are required.
- R18. Replace raw controls in the shell, capture detail/compact/activity surfaces, and any concrete section already changed by the R19-R20 surface inventory. Preserve values, ranges, steps, disabled states, event cadence, keyboard behavior, IPC frequency, and labels. Record unrelated raw controls outside changed surfaces as a follow-up inventory rather than making application-wide migration release-blocking here.
- R19. In-flow workspace content defaults to one page canvas with titled sections, separators, flat rows, selection backgrounds, and inline alerts. A child card must represent an independently actionable object or semantic boundary, not merely visual spacing.
- R20. Shadows are limited to actual overlays: menus, popovers, dialogs, non-modal overlay panes when required by tokens, and the desktop floating controller. In-flow cards and nested content sections use no elevation shadow.

**One capture authority and compact presentation**

- R21. DesktopCaptureService, the revisioned ApplicationSnapshot, and existing idempotent capture commands remain the only capture truth. Renderer views never invent a parallel recording phase or durable status.
- R22. Extract one main-window application-scoped capture controller from CaptureWorkspace for setup, preflight, recovery, detailed errors, and in-app pending state. Put capture-phase-to-compact-content mapping in a pure shared presentation module used by both Renderers. The floating Renderer may own only local confirmation and button-pending UI; it cannot own capture phase, recovery, or durable result state.
- R23. During recording, paused, or finalizing, the compact controller shows only status, elapsed duration, Pause/Resume when valid, Stop and Save when valid, Open Details, and at most one concise indicator. Partial/actionable failure replaces controls with Needs attention, Open Details, and Dismiss. Open Details retires the compact failure and acknowledges its activity item; Dismiss retires only the compact failure and leaves the activity item unread.
- R24. The compact controller must not contain meeting title entry, microphone selection, caption settings, full audio diagnostics, recovery lists, save paths, history, explanatory paragraphs, or multi-step forms.
- R25. Capture setup, preflight, title, microphone, caption option, detailed health, detailed errors, recovery management, and save/result information render as an application-owned capture-detail subview inside SidebarInset's third-column content area. It is not a fourth rail destination: record/Open Details replaces current route content while retaining the selected primary rail section, Back returns to the last primary route, and choosing another rail destination closes detail without affecting capture. Entry focuses the detail h1 or first actionable error; Back restores focus to the invoking control when it still exists.
- R26. Pause and Resume execute directly. Stop and Save uses the same inline two-step confirmation in both compact views: first activation reveals Cancel and Stop and Save, moves focus to confirmation, and Escape cancels. Confirmation disables repeated submission, retires if Main phase changed meanwhile, remains visible through finalizing after submission, and reports success only after durable commit appears in Main state.
- R27. Closing a view, switching routes, hiding the main window, hiding the floating controller, reloading a Renderer, or closing only the floating controller never stops capture.

**In-app and desktop floating presentations**

- R28. When capture is active and the main window is foregrounded, show the in-app compact controller at the top-right of the global inset header on every route. At 1240px it may show short text labels; at 1024px and 880px it remains one line, keeps status/timer plus Pause/Resume and Stop directly reachable as labeled icons, collapses Open Details to an icon, truncates the route title, and reduces offline state to its labeled status icon before hiding any capture action.
- R29. Floating mode defaults off. Settings and capture details expose a persistent Show floating control during recordings toggle; the first active recording also shows one non-modal in-app discovery action. When enabled and the user switches away, minimizes, or hides Main during active capture, show one controller near the active display's top-right work area. Closing it means Hide for this recording and suppresses automatic reappearance until that capture ends or the user chooses Show now in Main; Turn off floating control disables the persistent preference.
- R30. Main owns a debounced presentation coordinator. It distinguishes main-window blur from floating-window focus, prevents focus-trigger loops, hides the floating controller when the main window becomes foregrounded, and ensures the two presentations are never simultaneously prominent except during a bounded handoff frame.
- R31. The floating controller is one trusted, sandboxed, context-isolated local Renderer with a minimal typed Preload surface. Main derives a dedicated redacted FloatingCaptureSnapshot from the same capture authority; it contains only opaque session/revision identifiers, phase, timing, allowed actions, and generic attention state—never title, transcript, paths, recovery items, raw errors, activity, profile, library, or unrelated state. Canonical capture commands pass through an explicit server-side floating capability allowlist; database, native helper, raw IPC, setup, recovery, AI, import, export, and unrelated channels are denied.
- R32. The floating controller defaults to privacy-safe content: recording state, duration, compact controls, and app identity only. It omits meeting title and transcript text. Canonical geometry is 320px wide, at least 72px high, at most 112px high for confirmation/attention, and never internally scrolls. It appears without activating or stealing focus; pointer/assistive activation may focus it. Tab follows visual order, Escape hides it for the current recording, background-only drag regions exclude every interactive control, and Open Details activates Main and focuses detail. Bounds are clamped to current display workArea and restored safely after display removal or resolution change.

**Global activity entry**

- R33. Add one global top-right activity button adjacent to the in-app controller, with unread count and a concise popover or panel containing capture completion and actionable failure events.
- R34. ApplicationSnapshot gains a Main-owned activity projection containing at most 20 current-session items. Each item has a stable ID derived from capture session and terminal outcome, kind, opaque capture session ID, created time, generic localized title, severity, read/resolved state, and detail target. It never contains meeting title, transcript-derived text, filesystem path, or raw native error. Main appends only on the first durable completed/partial/failed transition, orders newest first, deduplicates by ID, and exposes one idempotent acknowledge-through action. Opening the panel acknowledges through the newest visible ID; later events remain unread. Empty state reads 暂无消息. Activating an item acknowledges it and opens details; closing restores focus to the activity button; launch resets the list.
- R35. The activity list is bounded to the current application session and capture-related terminal events. Durable audio history and recovery remain the authoritative cross-restart record; a general notification platform, system notifications, and persistent inbox are outside scope.

**Behavior, accessibility, and verification**

- R36. Preserve navigation, playback, processing reconciliation, editing, export, AI, pairing, transfer, capture/recovery, offline, profile, capability, sleep/wake, Renderer-loss, quit, and durable-commit behavior unless this contract explicitly changes presentation.
- R37. Preserve accessible names, aria-current, roving navigation, visible focus, one meaningful h1, live status announcements, and non-color-only states. Compact and floating controls expose identical action names and current recording state.
- R38. Use a surface inventory and computed-style assertions to prove representative second- and third-column views contain no redundant nested card stacks and no in-flow shadows.
- R39. Add deterministic Electron visual coverage for Sidebar geometry, correct icons/button sizes, flat hierarchy, in-app compact control, capture detail, global activity, and desktop floating control.
- R40. Add static or component-level regression assertions that ContextPaneTrigger renders the intended Lucide panel icon, rail actions retain official menu-button geometry, and visible controls do not fall back to Unicode glyphs.
- R41. Add Main tests for window creation, trusted sender binding, snapshot fan-out, command idempotency, focus/blur handoff, floating close/reopen, main minimize/restore, app activate, multi-display clamping, display removal, and teardown without ghost listeners.
- R42. Add capture tests for recording, paused, finalizing, completed, partial, failed, and recovery projection; hide/close does not stop; Stop and Save stays pending until durable commit; activity remains ordered and deduplicated.
- R43. The canonical visual environment remains macOS arm64 with repository-pinned Electron/Chromium, DPR 1, zh-CN, light mode, reduced motion, deterministic time/data, cleared presentation preference, and the declared font stack.

**Documentation and release truth**

- R44. Update Electron README and shell architecture documentation to name pinned sidebar-09 authority, explain intentional differences, define capture surface hierarchy, and document floating-window preference and privacy behavior.
- R45. Archive current release receipts under the existing superseded convention with an invalidation record naming the visual-fidelity and oversized capture-surface defects.
- R46. Return audio-sidebar-workstation.json to its existing pending schema with null active candidate bindings until a new stable package passes acceptance.
- R47. Extend manual checks with official side-by-side review, second-column density, card/shadow hierarchy, app/floating handoff, multi-display placement, focus, assistive input, sleep/wake, quit, and privacy-safe content.
- R48. Package once from a clean committed source, run automated and manual acceptance against that same artifact, and finalize without rebuilding.

### Acceptance Examples

- AE1. **Official shell geometry and icon identity**
  - **Covers:** R1-R9, R39-R40
  - **Given:** A deterministic 1240x820 Audio route with the context pane open.
  - **When:** The shell settles.
  - **Then:** The rail fills the viewport, total expanded Sidebar is 350px, default rail buttons are 32px, the pane trigger uses the panel icon rather than text arrows, and the inset header follows pinned grammar.
- AE2. **Flat information hierarchy**
  - **Covers:** R14-R20, R38-R40
  - **Given:** Audio transcript, Companion device, Caption, and Settings fixtures.
  - **When:** Populated, empty, selected, loading, and error states render.
  - **Then:** Rows and sections use separators and state backgrounds, no in-flow surface has elevation shadow, and cards remain only for approved semantic boundaries.
- AE3. **Cross-page in-app recording**
  - **Covers:** R21-R28, R36-R42
  - **Given:** Recording begins from capture details.
  - **When:** The user navigates among Audio, Companion, and Settings.
  - **Then:** The same top-right compact controller remains visible, duration and phase remain consistent, and setup/recovery content stays out of it.
- AE4. **Foreground-to-floating handoff**
  - **Covers:** R27-R32, R37, R39-R43
  - **Given:** Floating mode is enabled and capture is recording.
  - **When:** Voice2Text loses foreground, the floating controller receives focus, and Voice2Text is later reactivated.
  - **Then:** One floating controller appears at a valid work-area position without repeated focus stealing, its controls operate the same capture, and it hides as the in-app controller becomes prominent.
- AE5. **Stop, commit, and terminal activity**
  - **Covers:** R23-R27, R33-R35, R41-R42
  - **Given:** A recording is active in the floating controller.
  - **When:** The user confirms Stop and Save and Main enters finalizing.
  - **Then:** Repeated stop is disabled, the controller remains until durable completion, and one completion activity item appears in the main-window activity list.
- AE6. **Failure and recovery ownership**
  - **Covers:** R23-R27, R33-R37, R42
  - **Given:** Finalization returns partial or actionable failure.
  - **When:** The compact surface reports “needs attention.”
  - **Then:** Open Details reveals the third-column error/recovery workflow; the compact surface does not expand into a recovery form and hiding it does not discard the session.
- AE7. **Release truth**
  - **Covers:** R44-R48
  - **Given:** The old candidate is bound to the divergent and bottom-right-card implementation.
  - **When:** Work starts and later reaches a clean stable revision.
  - **Then:** Old receipts remain immutable under superseded, the manifest stops claiming the old pass, and only one newly packaged artifact restores validated status.

### Success Criteria

- Manual side-by-side review confirms official shell proportions, icon grammar, rail density, nested-column composition, flat rows, and inset-header hierarchy.
- Canonical screenshots and geometry assertions pass for shell, in-app compact capture, detail workspace, activity entry, and floating controller.
- No visible raw Unicode icon remains; no rail action overrides approved 32px geometry without an explicit exception.
- The approved surface inventory has no unexplained nested card stack and no in-flow shadow.
- Exactly one Main capture authority and one pure shared compact presentation mapping drive every recording view; Renderer-local state is limited to ephemeral interaction state, and all multi-window lifecycle/idempotency tests pass.
- One clean package, not the superseded package, owns final automated and manual evidence.

### Scope Boundaries

**In scope**

- Electron Sidebar composition, buttons/icons/controls, second- and third-column surface hierarchy, compact capture control, capture details, optional desktop floating control, current-session capture activity list, deterministic visual tests, Main/Preload multi-window wiring, documentation, and workstation release evidence.

**Outside this plan**

- Flutter/Goo UI; new capture-engine behavior; persistent or multi-category notification inbox; OS notifications; transcript text in the floating window; global keyboard shortcuts; automatic screen-share detection; Windows/Linux certification; dark-theme redesign; notarization; and production release.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Pin source, then audit application composition.** Use pinned official shadcn files as code and geometry references. Audit app-layer classes and wrappers that override primitives; do not bulk-overwrite local primitives.
- KTD2. **Make component identity testable.** Centralize semantic icon mappings and use existing SidebarTrigger, SidebarMenuButton, Button, and Lucide components. Tests assert roles, accessible names, icon identity, and computed geometry rather than only click outcomes.
- KTD3. **Keep one pane DOM and pane-state authority.** The nested pane remains one subtree controlled by useContextPaneShell; docked and overlay modes are projections, not duplicate views.
- KTD4. **Use a declared surface hierarchy.** A surface inventory assigns each major area page, section, row, alert, popover/dialog, or floating-window. New cards and shadows require the semantic exceptions in R19-R20.
- KTD5. **Extract one capture truth projection before moving UI.** Split CaptureWorkspace into a main-window controller/action adapter, pure shared presentation derivation, CaptureDetailSurface, InAppCaptureControl, FloatingCaptureControl, and CaptureActivityList. Separate Renderers may keep ephemeral interaction state, but phase, recovery, and durable outcomes always come from Main. (session-settled: user-directed — chosen over moving the existing all-in-one card: details must live in the third column.)
- KTD6. **Let Main coordinate windows, not recording truth.** A presentation coordinator observes capture phase and main-window activation/minimize/hide, owns the single floating BrowserWindow, and broadcasts to trusted windows. It never derives or mutates capture phase.
- KTD7. **Use a separate minimal Renderer, Preload, and redacted contract.** Add a second Forge Vite renderer named floating_capture_window with its own HTML/React entry and a separate floating Preload build entry. It shares only pure compact presentation code and FloatingCaptureSnapshot, uses secure preferences/navigation denial, and exposes redacted snapshot subscription plus pause/resume/stop/open-main/hide actions. Main enforces the capability allowlist before handler dispatch; narrow Preload is not treated as authorization.
- KTD8. **Put bounded activity in ApplicationSnapshot.** Add the R34 projection and acknowledge-through action to shared application contracts and Main application state. The in-memory item/read store lives for the application session, uses ApplicationSnapshot revision ordering, and is fanned out with the same snapshot; no notification database or Renderer-derived history is introduced.
- KTD9. **Validate visuals and window lifecycle independently.** Keep Vitest for presentation/controller semantics, add deterministic visual assertions, and test production Main coordination separately from the visual harness.
- KTD10. **Invalidate before replacing evidence.** Preserve old receipts, return manifest to pending, and use the existing package-once flow for the corrected candidate.

### High-Level Technical Design

~~~mermaid
flowchart LR
  Capture[DesktopCaptureService] --> AppState[Revisioned Application State]
  AppState --> Ipc[Typed IPC and Event Fan-out]
  Ipc --> Controller[Main-window Capture Controller]
  Ipc --> Model[Pure Shared Presentation Model]
  Controller --> Model
  Model --> InApp[In-app Top-right Control]
  Model --> Detail[Third-column Detail]
  Ipc --> Redacted[Redacted Floating Capture Snapshot]
  Redacted --> Float[Floating Renderer]
  AppState --> Activity[Terminal Activity Projection]
  Activity --> ActivityUI[Global Activity List]
  WindowEvents[Window and App Focus] --> Coordinator[Presentation Coordinator]
  Coordinator --> FloatWindow[Single Floating BrowserWindow]
~~~

The coordinator decides presentation prominence, not capture phase. The main Renderer keeps its controller mounted across routes; the floating Renderer independently derives the same compact model from revisioned Main truth and owns only ephemeral confirmation/pending UI. Main creates, shows, hides, repositions, and tears down or reuses the floating window. Both views use the same idempotent capture actions.

### Capture Surface Ownership

| Content/action | In-app compact | Desktop floating | Third-column detail | Global activity |
| --- | --- | --- | --- | --- |
| Recording/paused/finalizing state | Yes | Yes | Yes | No |
| Elapsed duration | Yes | Yes | Yes | No |
| Pause/Resume | Yes | Yes | Yes | No |
| Stop and Save | Confirmed | Confirmed | Yes | No |
| Open/return to details | Yes | Yes | N/A | Link only |
| Title, microphone, captions | No | No | Yes | No |
| Detailed health/error/recovery | Indicator | Indicator | Yes | Link only |
| Completion/failure history | No | No | Current result | Current-session terminal items |

### Presentation State Matrix

| Capture phase | Main foreground | Floating preference | Prominent surface |
| --- | --- | --- | --- |
| Idle/setup/preflight | Any | Any | Third-column detail only |
| Recording/paused | Yes | Any | In-app compact |
| Recording/paused | No/minimized/hidden | Enabled | Desktop floating |
| Recording/paused | No/minimized/hidden | Disabled | No floating; Tray/Main truth continues |
| Finalizing | Yes | Any | In-app compact until durable terminal state |
| Finalizing | No | Enabled | Desktop floating until durable terminal state |
| Partial/actionable failure | Yes | Any | In-app indicator plus details |
| Partial/actionable failure | No | Enabled | Floating indicator plus Open Details |
| Completed | Any | Any | Compact retires; one activity item is emitted |

Main blur does not immediately imply show floating. The coordinator uses a short debounce and excludes focus transitions into the floating window. Main activation or Return to Voice2Text takes precedence and hides the floating presentation after the in-app surface is ready.

### Failure and Activity Transition Matrix

| Main truth | Compact surface | Activity | Detail/acknowledgement |
| --- | --- | --- | --- |
| Recording or paused | Active controls | None | Details may be opened and closed without acknowledgement |
| Finalizing | Pending status; no repeated stop | None | Remains visible until durable terminal truth |
| Completed | Retires immediately | One unread completion item | Opening panel/item marks it read |
| Partial or recoverable failure | Needs attention + Open Details + Dismiss | One unread failure item | Open Details retires compact and marks item read; Dismiss retires compact only |
| Recovery later succeeds | No compact failure | Existing failure becomes resolved/read and one completion item may be appended for the new durable outcome | Detail shows durable result |
| Terminal failure with no recovery action | Needs attention until Open Details or Dismiss | One unread failure item | Detail explains outcome; acknowledgement does not rewrite failure as success |

### Floating Preference Lifecycle

| User action/state | Persistent preference | Current-capture suppression | Result |
| --- | --- | --- | --- |
| Default / never enabled | Off | No | No desktop floating window |
| Enable in Settings/details or discovery action | On | No | Shows on next qualifying loss of foreground |
| Close or press Escape in floating window | On | Yes | Hides for this recording and does not auto-reopen |
| Choose Show now in Main | On | No | Clears suppression and shows when Main is not foreground |
| Choose Turn off floating control | Off | No | Hides and stays disabled for future recordings |
| Capture ends | Unchanged | Reset | Next recording follows persistent preference |

### Surface Disposition Map

| Surface | Required disposition |
| --- | --- |
| Audio/Companion context panes | Flat full-width rows inside Sidebar groups |
| Transcript list | One scrollable region with segment separators |
| Playback, speaker, export, AI, Caption, Settings | Titled flat sections with dividers |
| Blocking/error truth | Alert or existing modal boundary |
| Capture details | Third-column sections; no nested floating cards |
| In-app capture | Compact header control with no elevation shadow |
| Global activity | Popover/panel anchored to one header action |
| Desktop capture | One 320px-wide always-on-top window with one token-consistent shadow and no internal scroll |

### Window and Security Design

- The floating window uses existing secureWebPreferences: no Node integration, context isolation, sandboxing, navigation denial, and restrictive CSP. It receives only FloatingCaptureSnapshot, never ApplicationSnapshot.
- IPC handlers remain registered once per channel. A window-aware trust registry maps allowed WebContents/main-frame/entry URL to main or floating capability sets; each invocation is authorized against that registry before reaching canonical handlers. Event subscriptions are fanned out and torn down per window.
- Snapshot fan-out iterates a registry of trusted presentation windows. Destroyed WebContents are removed without affecting others.
- Window bounds are stored in DIP, keyed by display identity when stable, then clamped to display workArea. Default placement uses active/cursor/main display top-right with a tokenized margin.
- alwaysOnTop is enabled only while the floating presentation is relevant. On macOS it is visible across normal workspaces but not above full-screen apps by default; Mission Control, workspace transitions, and process-type flicker are acceptance cases. Other platforms preserve their native supported behavior and remain uncertified in this plan.
- Floating-window close means hide this surface, never stop recording. App quit continues to use the existing capture lifecycle policy.

### IPC Capability Matrix

| Presentation | Allowed subscriptions/data | Allowed commands |
| --- | --- | --- |
| Main Renderer | Existing ApplicationSnapshot and existing domain events | Existing application command set plus activity acknowledgement and floating preference/show-now |
| Floating Renderer | FloatingCaptureSnapshot only | Pause, Resume, Stop and Save, Open Main Details, Hide for this recording |
| Any unregistered frame/window | None | None; reject before canonical handler dispatch |

### Sequencing Constraints

1. Invalidate old candidate evidence.
2. Lock official visual authority, icon mapping, surface inventory, deterministic harness, and initial shell/card fixtures.
3. Correct Sidebar composition and second/third-column hierarchy.
4. Extract the single capture controller and presentation model.
5. Land in-app compact control and third-column detail split.
6. Add Main-produced activity projection and global activity list.
7. Generalize IPC/window registration before creating a second Renderer.
8. Add floating window and presentation coordinator; harden focus, display, sleep/wake, quit, and recovery.
9. Consolidate baselines already added with each surface, run repeat-stability review, update documentation, and package/revalidate one clean candidate.

### Risks and Mitigations

- **Focus loop:** Floating focus can resemble returning to Voice2Text. Model main focus, app activation, and floating focus separately; debounce and test the matrix.
- **Second-window trust:** Current IPC binds one BrowserWindow. Introduce explicit per-window trust and teardown before showing the floating Renderer.
- **Duplicate controller:** CaptureWorkspace contains substantial local state. Extract controller and pure derived models first; prohibit local phase/recovery/pending copies in compact views.
- **Terminal duplication:** Snapshot refresh and reconnect can repeat terminal state. Generate stable activity IDs from session plus terminal outcome in Main, retain at most 20 items, and test append-once, ordering, acknowledgement, and deduplication.
- **Always-on-top intrusion:** Make it opt-in, privacy-safe, draggable, hideable, and easy to return to app; never show transcript/title.
- **Multi-display drift:** Clamp every restore and react to display removal and metrics changes.
- **Visual overcorrection:** Do not ban cards globally. Use semantic inventory and computed-style assertions rather than a brittle count.
- **Baseline noise:** Fix Electron, OS, DPR, fonts, locale, time, data, motion, and bounds for canonical screenshots.
- **Existing edits:** README and product-status files already have local changes. Merge around them.

### Sources and Research

- Official block: https://ui.shadcn.com/view/new-york-v4/sidebar-09
- Pinned shadcn source: https://github.com/shadcn-ui/ui/tree/25be24cca34d06eed29a4779c3f48c4816aa812c/apps/v4/registry/new-york-v4
- Registry manifest: https://ui.shadcn.com/r/styles/new-york-v4/sidebar-09.json
- Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
- Electron screen: https://www.electronjs.org/docs/latest/api/screen
- Electron security/context isolation: https://www.electronjs.org/docs/latest/tutorial/security
- Repository boundary learning: docs/solutions/architecture-patterns/desktop-first-workstation-boundaries.md
- Existing shell architecture: docs/architecture/electron-audio-context-shell.md
- Historical shell plan: docs/plans/2026-08-17-1554-refactor-electron-sidebar-09-context-shell-plan.md

---

## Implementation Units

### U1. Invalidate divergent release evidence

- **Goal:** Stop active evidence from claiming current visual hierarchy and bottom-right capture satisfy the target.
- **Requirements:** R45-R46
- **Files:** docs/product/audio-sidebar-workstation.json, docs/product/audio-sidebar-release, docs/product/desktop-workstation-status.md, validator tests
- **Dependencies:** None
- **Approach:** Move active receipts unchanged into timestamped superseded history, add an invalidation record naming both defects, and project manifest to pending.
- **Test scenarios:** Historical hashes remain; active bindings are null; pending validates; old candidate cannot regain validated status.
- **Verification:** Workstation manifest and release-candidate validator tests pass.

### U2. Bind official components and visual contracts

- **Goal:** Prevent app wrappers from overriding official button/icon geometry without detection.
- **Requirements:** R1-R7, R17-R18, R39-R40
- **Files:** apps/desktop-electron/src/renderer/components/ui, components/nav-main.tsx, App.tsx, index.css, focused tests
- **Dependencies:** None; run in parallel with U1
- **Approach:** Diff primitives, add only missing ones, remove size-10 rail overrides, replace Unicode trigger with panel icon grammar, and lock the existing deterministic Electron harness with initial component/geometry fixtures before broader UI migration.
- **Test scenarios:** Correct icon and accessible label; 32px rail actions; token states; no Unicode control icon.
- **Verification:** Focused component tests, typecheck, lint, and source scan pass.

### U3. Correct Sidebar shell and context panes

- **Goal:** Rebuild nested Sidebar composition and flat second-column treatment while preserving pane behavior.
- **Requirements:** R3-R16, R36-R40
- **Files:** App.tsx, app-sidebar.tsx, nav-main.tsx, features/shell, Audio/Companion features and tests
- **Dependencies:** U2
- **Approach:** Keep one pane DOM and persistent authority, implement docked/overlay projection, use Sidebar groups/rows, and preserve focus/dismissal/business behavior.
- **Test scenarios:** Supported width/route/preference states; focus restoration; overlay child interaction; all Audio/Companion states.
- **Verification:** Shell, navigation, Audio, Companion, and geometry tests pass.

### U4. Flatten third-column workspace surfaces

- **Goal:** Replace redundant card segmentation and in-flow elevation with declared hierarchy.
- **Requirements:** R17-R20, R36-R40
- **Files:** Third-column sections selected by the R19-R20 surface inventory, their shared primitives, and surface inventory tests
- **Dependencies:** U2-U3
- **Approach:** Flatten representative non-capture sections named by the surface inventory, migrate only controls inside those touched sections, retain approved card/alert/dialog boundaries, and add computed-style/visual assertions with each migrated section.
- **Test scenarios:** Transcript/playback/export, AI settings, Caption, device transfer, empty/loading/error, keyboard and labels.
- **Verification:** Renderer tests and surface inventory pass.

### U5. Extract capture controller and detail surface

- **Goal:** Establish one application-scoped capture controller and move detailed workflows into the third column.
- **Requirements:** R21-R27, R36-R42
- **Files:** features/capture/capture-workspace.tsx, new controller/presentation modules, App.tsx, features/shell/use-application-shell.ts, capture tests
- **Dependencies:** U2-U3; U4 proceeds in parallel
- **Approach:** Separate main-Renderer command/setup state from pure shared presentation derivation, retain Main snapshots/commands, flatten capture-detail-specific surfaces locally, and add the transient capture-detail subview in SidebarInset with the R25 entry, return, rail-selection, and focus rules.
- **Test scenarios:** Every phase; pending command; preflight; recovery; reload; Open Details/Back/rail navigation; invoking-control focus restoration; hide never stops; finalizing waits for durable truth.
- **Verification:** Capture workspace, Renderer flow, IPC, and lifecycle tests pass.

### U6. Add in-app compact capture and activity

- **Goal:** Deliver concise cross-page top-right behavior before multi-window complexity.
- **Requirements:** R23-R28, R33-R35, R37-R43
- **Files:** App.tsx, inset-header components, compact capture components, src/shared/contracts/application_state.ts, src/shared/contracts/ipc.ts, src/main/application/application_state.ts, src/main/ipc/desktop_ipc.ts, src/preload/api.ts, tests
- **Dependencies:** U5
- **Approach:** Use a compact allowlist, mount globally, implement the R26 inline confirmation, and extend ApplicationSnapshot with the bounded R34 activity projection plus acknowledge-through action.
- **Test scenarios:** Recording/paused/finalizing/failure/completed; routes and 1240/1024/880 header compression; content exclusions; confirmation focus/Escape/phase change; stop idempotency; unread/read acknowledgement; 20-item retention; order/dedup; Open Details.
- **Verification:** Focused Renderer, Main-state, Preload, and accessibility tests pass.

### U7. Generalize trusted IPC and window registration

- **Goal:** Support an additional presentation window without weakening security or duplicating business handlers.
- **Requirements:** R21, R27, R30-R32, R41-R42
- **Files:** src/main/ipc/register_desktop_ipc.ts, desktop_ipc.ts, src/preload, shared FloatingCaptureSnapshot and capability contracts, integration/security tests
- **Dependencies:** U5-U6
- **Approach:** Replace the current one-window register/unregister assumption with one global handler registration plus a per-window trust/capability registry and event fan-out. Reuse canonical capture handlers, expose the minimal floating API, and remove registry/listener entries on destruction.
- **Test scenarios:** Trusted main/floating senders; per-channel server-side denial; untrusted rejection; one process-wide handler owner; registry-only window teardown; redacted fan-out; reconnect revision; absence of title/path/error/activity/setup/recovery/unrelated data and APIs.
- **Verification:** IPC contract, integration, boundary, and lifecycle checks pass.

### U8. Implement floating controller and coordinator

- **Goal:** Provide optional desktop top-right recording control with stable focus and display behavior.
- **Requirements:** R27-R32, R36-R43
- **Files:** src/main/index.ts or extracted coordinator, forge.config.ts, vite.floating-renderer.config.mts, vite.floating-preload.config.mts, src/floating-preload.ts, floating renderer HTML/React entry, src/main/forge-env.d.ts, preference storage, visual harness, window tests
- **Dependencies:** U7
- **Approach:** Add the named separate Forge/Vite Renderer and Preload entries, create one secure compact BrowserWindow without activation, apply the Floating Preference Lifecycle, coordinate foreground handoff, persist/clamp bounds, handle displays, and reuse canonical actions/presentation mapping.
- **Test scenarios:** Default/discovery/enable/disable/show-now/current-capture suppression; blur/minimize/hide; pointer/assistive focus; tab/Escape; 320×72–112 geometry; drag-region exclusions; Open Details focus; restore/activate; normal workspace transition; no overlay above full-screen apps; Mission Control; display removal; phases; sleep/wake; quit; no focus loop.
- **Verification:** Main tests, Electron multi-window E2E, packaged smoke, and manual macOS checks pass.

### U9. Add deterministic visual baselines

- **Goal:** Make visual and hierarchy defects independently reproducible.
- **Requirements:** R38-R43
- **Files:** playwright.config.ts, visual harness, fixtures, geometry assertions, canonical goldens
- **Dependencies:** U2-U8
- **Approach:** Consolidate the incremental shell/card baselines from U2-U4, capture/detail/activity baselines from U5-U6, and floating baselines from U8; assert cross-surface geometry/computed styles, repeat stability, and official side-by-side evidence.
- **Test scenarios:** Audio open/in-app recording; Audio closed; Settings; 880x620 overlay/detail; Companion; activity popover; floating recording/paused/failure; repeat stability.
- **Verification:** Canonical visual lane passes twice without updates; geometry diagnoses structural drift.

### U10. Update documentation and bind one candidate

- **Goal:** Make architecture, manual checks, and release evidence describe shipped behavior truthfully.
- **Requirements:** R44-R48
- **Files:** Electron README, shell architecture, manual checks, workstation manifest/status, release tooling/tests
- **Dependencies:** U1-U9
- **Approach:** Document intentional differences, compact/detail/activity ownership, floating preference/privacy/lifecycle, and package gates. Preserve unrelated edits. Prepare, inspect, and finalize one clean candidate.
- **Test scenarios:** Dirty prepare refusal; visual/multi-window receipt; manual/package identity; same-hash finalize.
- **Verification:** Release tests, workstation validator, repository checks, and package-once acceptance pass.

---

## Verification Contract

| Gate | Command | Proves | Units |
| --- | --- | --- | --- |
| Cache guard | python3 tool/build_cache_guard.py --wait-for-idle | Repository and project cache budgets before build/test/package work | U1-U10 |
| Renderer and capture tests | bun run --cwd apps/desktop-electron test | Icon identity, pane state, compact/detail/activity semantics, accessibility | U2-U6 |
| IPC/security and window tests | bun run --cwd apps/desktop-electron test | Per-window trust, minimal floating API, fan-out, teardown, focus/display lifecycle | U7-U8 |
| Deterministic Electron visual lane | bun run --cwd apps/desktop-electron test:visual | Shell, hierarchy, compact/detail/activity/floating visuals and geometry | U3-U9 |
| Electron package checks | bun run --cwd apps/desktop-electron check | Format, lint, typecheck, tests, boundaries, lifecycle | U2-U9 |
| Workstation contract | python3 -m unittest tool/test_audio_sidebar_release_candidate.py tool/test_validate_audio_sidebar_workstation.py and python3 tool/validate_audio_sidebar_workstation.py | Pending/final manifest and immutable receipts | U1, U10 |
| Repository development check | ./tool/dev_check.sh | Cross-repository contracts | U1-U10 |
| Package-once acceptance | python3 tool/audio_sidebar_release_candidate.py prepare, manual receipt completion, then python3 tool/audio_sidebar_release_candidate.py finalize | One clean source/package identity owns evidence | U10 |
| UI watcher check | ./tool/ensure_ui_watcher.sh | Best-effort watcher requirement after code changes | U1-U10 |

Before any Flutter, Gradle, Xcode, packaging, build, test, benchmark, or code-generation command covered by repository policy, run python3 tool/build_cache_guard.py --wait-for-idle. Implementation uses scripts already declared by apps/desktop-electron/package.json, repository release tooling, and ./tool/dev_check.sh. Snapshot updates are never an ordinary verification shortcut.

---

## Definition of Done

- U1 is done when old receipts remain immutable as superseded history and active manifest returns to pending.
- U2-U3 are done when pinned shell composition, panel icon, 32px rail controls, responsive geometry, pane authority, focus, and flat rows pass semantic and geometry tests.
- U4 is done when representative third-column views satisfy the surface inventory with no unexplained nested cards or in-flow shadows.
- U5 is done when the main-window controller owns setup/detail state, both Renderers share pure compact mapping, neither duplicates Main capture truth, and details live in the SidebarInset third-column subview.
- U6 is done when the in-app controller is concise and cross-page, Stop and Save follows durable truth, and ordered/deduplicated current-session terminal activity appears globally.
- U7 is done when trusted windows share canonical handlers and snapshots without broadening floating Preload or leaking listeners.
- U8 is done when optional floating control passes handoff, focus, privacy, display, close/reopen, sleep/wake, quit, and recovery without changing capture semantics.
- U9 is done when canonical screenshots, geometry/computed-style assertions, repeat stability, and manual side-by-side review pass.
- U10 is done when docs/manual checks match delivered behavior and one clean package completes acceptance without rebuild.
- The final diff contains no duplicate capture truth, floating-specific business state, raw Unicode control icon, unexplained 40px rail override, abandoned bottom-right capture card, ghost IPC listener, dead experimental scaffold, or unrelated Flutter change.
- Every gate passes from the same final source revision.
