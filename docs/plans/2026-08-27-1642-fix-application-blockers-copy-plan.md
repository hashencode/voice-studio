---
title: Electron Application Blockers and UI Copy Consistency - Plan
type: fix
date: 2026-08-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Electron Application Blockers and UI Copy Consistency

## Goal Capsule

Make every genuinely non-skippable Electron process blocker behave as an application-level modal that cannot be dismissed or bypassed until the blocking condition is cleared. In the same change set, bring all production user-facing copy in the Electron application into compliance with the concise, natural, action-relevant guidance in `AGENTS.md`.

Success means the current local-library repair state remains visibly blocking throughout a truthful recheck, the ineffective repair-guidance action is removed end to end, blocked-time navigation cannot surface or replay, other qualifying Electron blockers follow the same semantic contract, and ordinary recoverable errors remain appropriately local and dismissible.

---

## Product Contract

### Actors

- **End user:** needs to understand what prevents progress and what real action is available.
- **Electron application shell:** owns global profile readiness, routing, modal coordination, and native desktop entry points.
- **Initialization and recovery services:** provide blocker state and diagnostic facts without deciding page-level presentation.

### Requirements

- **R1 — Blocker classification:** Treat a state as application-blocking only when the user cannot safely continue and no supported skip path exists.
- **R2 — Global presentation:** Render every state classified by R1 in the platform-standard root modal layer, independent of the current page.
- **R3 — No dismissal or bypass:** While blocked, close controls, Escape, mask taps, system back, route changes, pane changes, settings/detail entry, and capture entry must not expose usable background UI.
- **R4 — Continuous blocking lifecycle:** Once a blocker is shown, keep it latched through recheck, repeated blocked results, and request failures; release it only after a newer authoritative ready state arrives.
- **R5 — Navigation disposal:** Discard deep links, hashes, queued routes, and pending modal-authorized navigation received during the blocked lifecycle. Do not replay them after recovery.
- **R6 — Truthful recheck:** Expose one single-flight recheck action, show its pending state, prevent duplicate requests, and keep a concise actionable error in the modal if the request fails.
- **R7 — Remove ineffective guidance:** Delete the `repair-guidance` action, its button, and every renderer, preload, IPC, Main, contract, and test branch that exists only to support that no-op.
- **R8 — Preserve application exit:** Blocking in-app work must not prevent the operating system's normal quit/termination path.
- **R9 — Electron-wide copy rule:** All production user-facing copy in Electron must be concise, natural, considerate, and limited to information that changes the user's next action or decision.
- **R10 — Honest controls:** Labels and descriptions must match behavior that is actually available; do not describe nonexistent repair, retry, navigation, or recovery capabilities.
- **R11 — Safe diagnostics:** Do not surface raw internal errors, paths, byte counts, protocol values, or implementation details as primary user copy. Translate only the facts needed to decide or act, while preserving diagnostics for logs where appropriate.
- **R12 — Scope boundary for copy:** Audit rendered production surfaces and upstream values displayed verbatim. Exclude logs, privacy diagnostics, protocol codes, persisted internal data, documentation, and test-only fixtures unless they are intentionally user-visible.
- **R13 — Accessibility boundary:** Preserve the standard semantics, keyboard behavior, modal focus containment, and ordinary trigger restoration supplied by the existing shadcn/Radix composition. Add no live-region protocol, global announcer, custom focus state machine, or other accessibility mechanism unless this plan's blocker behavior exposes a reproducible gap that the existing primitives cannot cover.
- **R14 — Preserve ordinary error semantics:** Recoverable or nonblocking validation, toast, snackbar, inline error, result, consent, and cancellable-progress flows remain local or dismissible unless they independently meet R1.
- **R15 — Preserve platform contracts:** Keep existing business behavior, state ownership, keyboard/focus restoration, callbacks, storage contracts, and platform-specific component guidance except where these requirements explicitly change them.
- **R16 — Interaction proof:** Tests must prove blocker lifecycle, non-dismissal, navigation disposal, recheck behavior, action removal, copy mapping, and ordinary-error non-regression at the nearest stable boundary.

### Acceptance Examples

- **AE1 — Initial profile block:** Given the application starts with a local-library profile blocker, when the shell restores, then a global modal is present and the underlying page cannot be navigated or operated.
- **AE2 — Recheck remains blocked:** Given the blocker is visible, when the user starts recheck and initialization reports `initializing` before returning another blocked snapshot, then the same modal remains mounted, shows a single pending action, and updates its reason without exposing the app.
- **AE3 — Recheck succeeds:** Given a latched blocker, when a higher-revision ready snapshot arrives, then the modal closes once and normal navigation becomes available.
- **AE4 — Recheck request fails:** Given a latched blocker, when the recheck request rejects, then the modal remains non-dismissible and shows brief retry-relevant feedback without raw diagnostics.
- **AE5 — Navigation during block:** Given a blocker is active, when sidebar, pane, settings, capture-detail, deep-link, hash, or modal-authorized navigation is requested, then it is discarded and does not execute after recovery.
- **AE6 — No repair guidance:** Given the profile is blocked, then no repair-guidance control or corresponding IPC action is available.
- **AE8 — Ordinary error:** Given a recoverable validation or operation error that does not meet R1, then it continues to use its suitable inline, toast, snackbar, result, or cancellable-dialog treatment.
- **AE9 — Copy compliance:** Given any production Electron UI surface, then its title, description, controls, status, and existing accessible labels contain only user-relevant state and real next actions, without repeating visible controls or capabilities or introducing a new announcement mechanism.

### Key Product Decisions

1. **A genuine non-skippable Electron blocker is global and cannot be actively closed or bypassed.** (session-settled: user-directed — chosen over page-local or visually blocking treatment because the application must enforce the process constraint consistently.) Governs R1–R6, R8, R14–R16.
2. **The copy requirement applies to all production Electron UI, not only the current blocker.** (session-settled: user-directed — chosen over a one-dialog wording edit because `AGENTS.md` defines an interface-copy rule for the scoped application.) Governs R9–R12, R14–R16.
3. **Ordinary recoverable and nonblocking errors retain proportionate presentation.** (session-settled: user-approved — chosen over converting every error into a global modal because only states with no safe continuation meet the blocker definition.) Governs R1, R14–R16.

---

## Scope Boundaries

### In Scope

- Electron renderer, floating renderer, Main-native UI, and user-visible state/error producers whose values reach those surfaces.
- Electron profile initialization blocker presentation, lifecycle, navigation policy, action contracts, and tests.
- Shared semantic components and focused regression tests that prevent page-by-page reimplementation.

### Out of Scope

- Rewriting logs, telemetry, privacy diagnostics, protocol identifiers, persisted internal values, or developer-only error detail.
- Changing the underlying local-library repair algorithm, storage format, or profile initialization policy beyond making recheck truthful and presentation consistent.
- Adding a new automated natural-language linter or a blanket source-string rule; copy quality requires rendered-surface review and focused assertions.
- Restyling Electron primitives outside the scoped official Radix/Nova contract.
- Adding hidden live regions, global announcers, custom screen-reader state protocols, or cross-page focus choreography for the blocker when existing Dialog title, description, controls, and focus containment already convey the required state.
- Auditing or cleaning historical accessibility implementations outside files directly touched by this blocker and copy work.
- Visual validation, screenshots, goldens, browser control, simulator/device launch, and UI watcher execution; the user has not authorized visual validation for this task.

### Deferred to Follow-Up Work

- Electron i18n catalog/runtime migration. Use the reviewed production-copy inventory from this work as migration input, but do not combine framework adoption, locale switching, or translation delivery with the current blocker fix.
- Repair automation that can perform a real fix rather than recheck the current condition; no such capability is implied by this plan.
- A separate evidence-led Electron accessibility cleanup after this plan lands. It may inventory historical custom announcements and focus overrides, but must preserve valid native/Radix semantics and cannot become a general redesign.

---

## Key Technical Decisions

1. **KTD1 — Create a shared semantic Electron application-blocker wrapper from existing primitives.** (session-settled: user-directed — chosen over per-page blocker markup because R2–R4 require consistent root behavior.) It composes the existing Dialog/modal coordinator without duplicating Nova surface styles. Covers R2–R4, R15.
2. **KTD2 — Latch Electron blocker state in the application shell across transient initialization states.** (session-settled: user-approved — chosen over rendering only the current `blocked` snapshot because that creates a bypass window during recheck.) The last authoritative blocker remains visible until a newer ready revision releases it. Covers R3–R6, R16.
3. **KTD3 — Drop blocked-time navigation instead of queuing it.** (session-settled: user-approved — chosen over replay after recovery because stale deep links and modal-authorized callbacks could move the user somewhere they did not choose after the blocker cleared.) Covers R3, R5, R16.
4. **KTD4 — Audit copy by rendered sink and trace dynamic values to their producer.** (session-settled: user-directed — chosen over literal-string compression because R9 applies to all delivered user copy, including Main/native and service-produced messages.) Covers R9–R12, R14–R16.
5. **KTD5 — Keep the work in a new focused plan.** (session-settled: user-directed — chosen over expanding `docs/plans/2026-08-25-1021-fix-desktop-input-workspaces-plan.md` because this work has a distinct Electron blocker and copy contract.) The earlier plan remains an interaction-contract reference, especially for modal navigation behavior.
6. **KTD6 — Preserve the existing shadcn/Radix accessibility baseline without extending it.** (session-settled: user-directed — chosen over adding blocker-specific announcements or a new focus protocol because the current primitives already provide Dialog title/description semantics and modal focus behavior.) Custom accessibility behavior requires a reproducible application gap. Covers R13, R15–R16.

---

## High-Level Technical Design

These sketches describe ownership and invariants, not exact APIs or implementation code.

### Sketch 1 — Component Ownership

```text
profile/recovery services
        |
        v
platform application state -----> user-safe message mapping
        |                                   |
        v                                   v
root application shell ----------> semantic blocker wrapper
        |                                   |
        +---- navigation policy              +---- existing platform dialog primitive
        +---- modal coordination             +---- focus/dismissal contract
```

Services own facts and state. The application shell owns whether the whole app is blocked. Shared platform primitives own presentation mechanics; feature code supplies only contextual content and real actions.

### Sketch 2 — Blocker Classification Decision

```text
Can the user safely continue elsewhere?
  |-- yes --> Is this operation explicitly cancellable?
  |             |-- yes --> local/cancellable progress or dialog
  |             `-- no  --> inline/result/toast/snackbar as appropriate
  `-- no  --> Is there a supported skip path?
                |-- yes --> modal may expose that real skip action
                `-- no  --> root non-dismissible application blocker
```

The classification is semantic, not based on severity words or whether an existing component already happens to be non-dismissible.

### Sketch 3 — Electron Recheck Protocol

```text
User          Blocker UI        Renderer shell       Main state
 |                |                   |                  |
 |-- Recheck ---->|                   |                  |
 |                |-- one request -->|-- bootstrap ---->|
 |                |  pending/locked  |<-- initializing -|
 |                |  remains visible|                  |
 |                |                   |<-- blocked/ready-|
 |                |<-- newer snapshot|                  |
 |                | update or release|                  |
```

Only one request may be active. A request error updates the retained modal; it does not synthesize readiness or release the blocker.

### Sketch 4 — Electron Blocker State Machine

```text
restoring
  |-- ready ------------------------------> normal
  `-- blocked ----------------------------> blocked-latched
                                               |
                          Recheck               v
                                         checking-latched
                                           |         |
                          request error ----'         |-- newer blocked --> blocked-latched
                                                     `-- newer ready ----> normal
```

Stale or same-revision readiness cannot release the latch. Repeated blocked snapshots may replace the displayed cause while preserving modal identity and focus containment.

### Sketch 5 — Blocked Navigation Lifecycle

```text
blocker activates
  -> clear previously authorized pending modal navigation
  -> reject and discard route/pane/settings/capture/deep-link/hash intents
  -> continue accepting state and quit/termination events
  -> authoritative ready revision releases blocker
  -> resume from the shell's valid current route; replay nothing
```

The application blocker has priority over ordinary feature modals so background modal callbacks cannot become a delayed bypass.

### Sketch 6 — Copy Delivery Flow

```text
state/error fact
  -> producer mapping (when dynamic)
  -> renderer/native/widget surface
  -> title + decision-relevant context + real action
  -> nearest interaction assertion
```

Each audit starts at what the user sees, then follows verbatim dynamic values upstream. Internal detail remains available to diagnostics without becoming interface copy.

---

## Planning Contract

### Delivery Shape

- Implement in dependency order: shared semantics, blocker lifecycle/contracts, platform-specific blockers, then surface-by-surface copy audits and final verification.
- Keep each unit reviewable and independently testable. Do not mix unrelated style refactors into the copy sweep.
- Before editing, inspect the working-tree diff for every target file. Preserve user changes, especially current edits in Electron shell tests, navigation tests, IPC contracts, Main/storage code, and settings surfaces.
- Use `rg`-based rendered-sink inventories and reference tracing to bound each copy pass; record the reviewed surface groups in the implementation notes or commit description.
- Before generalizing the blocker semantic, make a lightweight inventory of existing production Electron process blockers and classify only those flows by whether the user can safely continue or explicitly cancel. Do not invent future blockers or extend this audit to Flutter/mobile.
- Do not overwrite customized Radix primitives wholesale and do not add shared-package presentation policy that belongs to an application.
- Use existing Dialog Title, Description, controls, keyboard handling, and modal focus behavior as the accessibility baseline. Do not turn copy review or blocker implementation into an accessibility framework or historical cleanup pass.

### Dependency Order

```text
U1 Electron blocker semantic
  -> U2 Electron lifecycle, navigation, and action contract
      -> U3 Electron production-copy audit

U2 + U3 -> U7 Electron verification and cleanup
```

### Change Safety

- Treat existing uncommitted changes as user-owned. Rebase planned edits around them at hunk level and stop for direction only if behavior cannot be preserved.
- Keep action-contract deletion atomic across shared contracts, preload, IPC registration, Main handling, renderer use, and tests so no temporary unsupported action remains.
- Prefer exact focused copy assertions only for high-risk blocker/recovery surfaces. Avoid snapshot churn and brittle tests that freeze all prose.
- Treat review findings as advisory evidence, not requirements. Apply a finding only when it closes an explicit requirement, a demonstrated defect, or an implementation gap required by the chosen design; defer speculative hardening, new framework work, and cross-surface expansion.
- Do not add custom announcement or focus behavior merely to satisfy a hypothetical review scenario. If the existing primitive composition exposes a reproducible gap, document that evidence and implement the smallest local correction.
- Do not launch or control any UI process. Static and non-visual tests only.

---

## Implementation Units

### U1 — Add the Electron semantic application blocker

**Outcome:** Electron has one reusable root-level blocker semantic that enforces modal coordination, focus containment, and non-dismissal without duplicating primitive styling.

**Requirements:** R1–R4, R8, R13, R15–R16; implements KTD1 and KTD6.

**Primary paths:**

- `apps/desktop-electron/src/renderer/components/ui/dialog.tsx`
- `apps/desktop-electron/src/renderer/components/ui/alert-dialog.tsx`
- `apps/desktop-electron/src/renderer/components/ui/modal-coordinator.tsx`
- A narrowly named shared semantic component under `apps/desktop-electron/src/renderer/components/`
- `apps/desktop-electron/tests/unit/renderer/ui_primitives_test.tsx`

**Approach:** Compose the existing Dialog and modal coordinator into a semantic blocker that omits close UI, prevents Escape/outside dismissal, preserves the primitive's existing title/description and modal focus behavior, and participates in the established token lifecycle. Add an application-blocker priority/activation hook that can clear pending authorized navigation without changing decorative defaults or introducing a live region, announcer, autofocus override, or custom focus state machine.

**Execution note:** Characterize the existing ordinary-dialog and pending-navigation behavior before adding blocker-specific expectations, so the semantic extension does not regress normal modals.

**Test scenarios:**

- Open the blocker, verify its existing Dialog title and description are present, attempt Escape and overlay dismissal, and verify it remains open without replacing the primitive's modal focus behavior.
- Activate it while an ordinary modal has a pending authorized destination; verify the pending destination is cleared and cannot fire later.
- Close it only through a controlled authoritative state change and verify no blocker-specific post-close focus routing was introduced.
- Exercise an ordinary dismissible dialog afterward and verify its existing close, callback, and navigation behavior remains unchanged.

### U2 — Replace the Electron profile page blocker with a latched application lifecycle

**Outcome:** The local-library repair condition blocks the whole Electron app continuously, exposes only a truthful single-flight recheck, and has no repair-guidance action or navigation bypass.

**Requirements:** R2–R8, R10–R12, R15–R16; implements KTD2 and KTD3.

**Primary paths:**

- `apps/desktop-electron/src/renderer/App.tsx`
- `apps/desktop-electron/src/renderer/features/shell/shell-surfaces.tsx`
- `apps/desktop-electron/src/renderer/features/shell/use-application-shell.ts`
- `apps/desktop-electron/src/shared/contracts/application_state.ts`
- `apps/desktop-electron/src/shared/contracts/ipc.ts`
- `apps/desktop-electron/src/preload/api.ts`
- `apps/desktop-electron/src/main/ipc/desktop_ipc.ts`
- `apps/desktop-electron/src/main/index.ts`
- `apps/desktop-electron/src/main/profile/audio_profile.ts`
- `apps/desktop-electron/tests/unit/renderer/shell_test.tsx`
- `apps/desktop-electron/tests/unit/ipc_contract_test.ts`
- `apps/desktop-electron/tests/integration/register_desktop_ipc_test.ts`
- `apps/desktop-electron/tests/integration/profile_initialization_test.ts`
- `apps/desktop-electron/tests/integration/audio_profile_reset_test.ts`
- `apps/desktop-electron/tests/e2e/sidebar_navigation_test.ts`

**Approach:** First inventory the existing production Electron process blockers and record the classification evidence for each; migrate only flows that genuinely have no safe continue or cancel path. For the reported local-library condition, mount the blocker at `App` scope rather than inside page content. Retain the last blocked cause across `initializing` and request failures, gate release on a newer ready revision, and make recheck single-flight. Rename the remaining action to recheck where that makes the contract truthful. Remove `repair-guidance` across every layer. While latched, drop initial and runtime deep links plus all renderer navigation intents, clear pending modal navigation, and give the application blocker precedence over ordinary modals. Keep OS quit outside this policy.

**Execution note:** Build the state-machine tests first around blocked → checking → blocked/ready/error, then migrate the component and contract so the transient initialization bypass is caught immediately.

**Test scenarios:**

- Restore directly into blocked state and verify the root modal replaces the former page alert on every route.
- Click recheck twice and verify one IPC request, a disabled/pending action, and no modal unmount during `initializing`.
- Return a newer blocked snapshot with a different cause and verify the same modal updates and remains latched.
- Return a higher-revision ready snapshot and verify one release; return stale or same-revision ready data and verify no release.
- Reject the IPC request and verify concise inline feedback, an enabled retry afterward, and no raw error leakage.
- Send sidebar, pane, settings, capture-detail, hash, initial deep-link, runtime deep-link, and modal-authorized navigation during the latch; verify every intent is discarded and none replays after ready.
- Verify ordinary modal behavior returns after readiness and OS/application quit remains available.
- Assert the shared action enum, preload exposure, IPC schema, handler registration, and Main switch contain recheck only and no `repair-guidance` branch.
- Cover profile causes, including insufficient-space facts, through user-safe mappings rather than direct internal byte/path prose.

### U3 — Audit and correct all Electron production UI copy

**Outcome:** Every Electron user-visible production string and dynamic message follows `AGENTS.md` and describes only real state, decisions, and actions.

**Requirements:** R9–R12, R14–R16; implements KTD4.

**Primary paths:**

- `apps/desktop-electron/src/renderer/**/*.{ts,tsx}`
- `apps/desktop-electron/src/floating-renderer/floating-capture-app.tsx`
- `apps/desktop-electron/src/main/index.ts`
- `apps/desktop-electron/src/main/domain/capture/capture_lifecycle_policy.ts`
- `apps/desktop-electron/src/main/resources/model_storage_access.ts`
- `apps/desktop-electron/src/main/application/application_state.ts`
- `apps/desktop-electron/src/main/profile/audio_profile.ts`
- Other Main/domain/resource producers found by tracing values displayed verbatim
- Nearest existing renderer, Main, and integration tests for each changed surface

**Approach:** Inventory rendered sinks first, then trace dynamic messages to their source. Maintain a lightweight review matrix in the implementation notes, grouped by rendered surface, with the displayed copy or dynamic producer, the next user decision/action, a keep/change decision, and any high-risk assertion needed. Review in risk order: blockers/recovery/native dialogs; toast/snackbar/inline errors and dynamic mappings; loading/empty/help/consent states; buttons, status text, and already-existing accessible names. Remove repetition, implementation exposition, unavailable promises, and labels that merely restate visible controls. Preserve internal detail in diagnostic channels. Do not add or redesign accessibility mechanisms during the copy audit. The matrix is the input for a later Electron i18n migration; this unit does not install or design an i18n runtime.

**Execution note:** Split reviewable changes by coherent surface group. Do not use a repository-wide blind replacement, and reconcile all touched files with the existing dirty diff before editing.

**Test scenarios:**

- For each high-risk blocker, recovery, and native dialog changed, assert the title, decision-relevant context, and available actions match actual behavior.
- Feed representative dynamic Main/profile/resource errors into their renderer surface and verify user-safe copy while diagnostic detail remains out of primary UI.
- Verify empty/loading/status copy does not claim completion, repair, upload, navigation, or retry before that capability exists.
- Verify changed controls and already-existing accessible names remain distinguishable and do not duplicate adjacent visible explanations; do not add hidden announcements to satisfy this copy check.
- Exercise representative ordinary validation/toast/result flows and verify they remain local or dismissible per R14.

### U7 — Complete Electron consistency and verification

**Outcome:** The final code state has no orphaned action paths, bypasses, or out-of-scope copy changes, and all required non-visual verification lanes pass.

**Requirements:** R1–R16; validates KTD1–KTD6.

**Primary paths:**

- All paths changed by U1–U3
- Root workspace/dependency manifests used to confirm reverse consumers
- `docs/plans/2026-08-25-1021-fix-desktop-input-workspaces-plan.md` for existing global-modal interaction compatibility

**Approach:** Re-run reference searches for deleted action names, page-local Electron blocker remnants, raw dynamic copy sinks, and blocker navigation entry points. Derive Electron reverse consumers from workspace membership, imports, and references. Run the verification contract once for the final code state, deduplicating narrower checks already covered by broader gates.

**Test scenarios:**

- Search production code and contracts and verify no `repair-guidance` action or ineffective guidance label remains.
- Verify every identified R1 state uses the correct platform root blocker and every reviewed R14 example remains proportionate.
- Verify blocked navigation is discarded across the combined modal/navigation contract described by the earlier desktop plan.
- Review the final diff against the initial dirty-tree inventory and verify no user-owned hunk was lost or silently rewritten.

---

## Verification Contract

### Static Review Before Tests

- Inspect the final diff and the initial working-tree inventory together; isolate plan changes from pre-existing user work.
- Search for `repair-guidance`, its displayed label, and obsolete action branches across Electron production and test code; expect no supported path.
- Search for the former `ProfileBlocker` page-local presentation and confirm profile blocking is owned by the root shell.
- Review the semantic blocker wrapper against `AGENTS.md` and the existing Electron primitive APIs. Do not invent component options.
- Confirm the blocker relies on existing Dialog title/description and modal focus behavior, with no new live region, announcer, autofocus override, or global focus protocol unless a reproducible gap is documented.
- Review the copy inventory coverage notes against every in-scope production sink and upstream verbatim producer.

### Electron Focused Tests

From `apps/desktop-electron`, run the narrowest affected Vitest targets first, including:

- `tests/unit/renderer/ui_primitives_test.tsx`
- `tests/unit/renderer/shell_test.tsx`
- `tests/unit/ipc_contract_test.ts`
- `tests/integration/register_desktop_ipc_test.ts`
- `tests/integration/profile_initialization_test.ts`
- `tests/integration/audio_profile_reset_test.ts`
- `tests/e2e/sidebar_navigation_test.ts`
- Nearest tests for every additional copy-bearing surface changed in U3

Then run `bun run check:code` because Main, Preload, shared contracts, and worker-facing integration are affected.

Do not run `bun run check:ui:quick` or `bun run check:ui`; those commands are in the visual-validation lane and the user has not authorized visual validation.

Do not run the UI watcher, screenshots, browser-driven checks, or other visual validation without a new explicit authorization. Do not run the repository-wide gate unless implementation evidence expands the reverse-consumer set beyond Electron.

### Manual Non-Visual Review

- Confirm each blocker has one decision-relevant explanation and only real actions.
- Confirm recheck copy and pending state do not imply a repair operation.
- Confirm no blocker can vanish during a transient state or failed request.
- Confirm blocked-time navigation is discarded, not queued.
- Confirm ordinary recoverable/cancellable flows were not promoted to application blockers.

---

## Risks and Mitigations

- **Transient bypass during recheck:** Snapshot-only rendering can unmount the blocker on `initializing`. Mitigate with the revision-aware latch and state-machine tests in U2.
- **Delayed navigation after recovery:** Existing pending modal authorization or deep links can fire later. Mitigate by clearing on activation and dropping all blocked-time intents per KTD3.
- **Competing root modals:** An ordinary modal may already be open. Give the application blocker explicit priority and test that background callbacks cannot survive it.
- **Over-classifying errors:** A blanket migration would make normal failures hostile. Apply the R1 decision test and preserve representative R14 flows in regression tests.
- **Copy audit blind spots:** Literal searches miss dynamic and native strings. Audit Electron sinks first and trace values upstream.
- **Copy assertions becoming brittle:** Freeze exact wording only for high-risk decisions/actions; test semantics and available controls elsewhere.
- **Accessibility scope expansion:** Reviewers may turn ordinary dynamic copy into announcement and focus protocols. Enforce R13/KTD6, preserve the Radix baseline, and defer historical cleanup to its own evidence-led task.
- **Dirty-tree collisions:** Several Electron contracts and tests already contain user changes. Inventory and reconcile hunks before each unit; never replace whole customized files.
- **Large review surface:** Keep U3 grouped by coherent Electron surface category and require focused tests before the final Electron gate.

---

## Definition of Done

- Every production state that meets R1 is enumerated and uses the correct platform root blocker; no page-local imitation remains.
- The Electron local-library blocker stays mounted through recheck, repeated blocked results, and request failures, and releases only on a newer authoritative ready state.
- Escape, mask tap, system back, in-app navigation, deep links, hashes, pane/settings/capture entry, and pending modal navigation cannot dismiss or bypass an active blocker.
- Blocked-time navigation is discarded and does not replay after recovery; OS quit remains available.
- Recheck is truthful, single-flight, visibly pending, retryable after request failure, and free of raw diagnostic copy.
- `repair-guidance` is removed from UI, contracts, preload, IPC, Main behavior, and tests.
- All Electron production user-facing copy and displayed dynamic messages have been reviewed under R9–R12, with high-risk surfaces protected by focused assertions.
- Representative ordinary recoverable, cancellable, and nonblocking flows remain proportionate and dismissible.
- Existing Radix/Nova APIs, Dialog title/description semantics, modal focus/keyboard contracts, and user-owned working-tree changes are preserved without adding a live-region or custom focus framework.
- Required focused Electron tests and `bun run check:code` pass, or unrelated pre-existing failures are isolated with evidence.
- Visual validation is explicitly recorded as skipped because it was not authorized for this task.

---

## Sources

- `AGENTS.md`
- `apps/desktop-electron/src/renderer/features/shell/shell-surfaces.tsx`
- `apps/desktop-electron/src/renderer/features/shell/use-application-shell.ts`
- `apps/desktop-electron/src/renderer/App.tsx`
- `apps/desktop-electron/src/renderer/components/ui/dialog.tsx`
- `apps/desktop-electron/src/renderer/components/ui/modal-coordinator.tsx`
- `apps/desktop-electron/src/shared/contracts/application_state.ts`
- `apps/desktop-electron/src/main/index.ts`
- `apps/desktop-electron/src/main/profile/audio_profile.ts`
- `docs/plans/2026-08-25-1021-fix-desktop-input-workspaces-plan.md`
- `docs/solutions/architecture-patterns/desktop-first-workstation-boundaries.md`
