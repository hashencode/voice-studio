# Electron Audio context shell

This document describes the current Electron desktop composition. The active
implementation rules are in `docs/standards/electron-renderer.md`; earlier
workstation closure records are historical evidence, not current product rules.

## Visual authority and composition

The shell began from shadcn's `sidebar-09` block at commit
[`25be24cca34d06eed29a4779c3f48c4816aa812c`](https://github.com/shadcn-ui/ui/tree/25be24cca34d06eed29a4779c3f48c4816aa812c/apps/v4/registry/new-york-v4/blocks/sidebar-09).
One `SidebarProvider` owns a 49 px primary navigation rail, a docked context
pane whose default width is 300 px and whose user-adjustable range is 240–480
px, and the remaining main `SidebarInset`. The context-pane width also clamps
to preserve at least 480 px of main content. The inset owns its bordered
header, scrollable content, and optional footer. Page-level content fills the
remaining width; local text or controls may have narrower readable measures.

Voice2Text replaces the block's mail demo with Audio, Companion, Messages, and
Settings destinations. Each destination owns its context-pane open preference;
the pane remains docked at supported window widths. The local Radix Nova
primitives and Electron-specific styling rules govern the active renderer.

## Navigation and ownership

The permanent rail has four destinations: `audio` (`音频`) and `companion`
(`互联`) in the main group, with `messages` (`消息`) and `settings` (`设置`)
in the footer group. Audio owns record,
import, search, list, selected detail, playback, editing, intelligence, export,
and processing actions. There is no standalone task or library route.

All four destinations keep independent context-pane open preferences. Resizing,
changing destinations, and selecting list items do not mutate those
preferences. Only an explicit pane action changes the relevant preference.

Each main workspace exposes one meaningful level-one heading. Destination
changes move focus to the destination heading or named primary control.
Capture and recovery remain app-level surfaces, so the non-modal drawer cannot
make either one unreachable. Processing has one app-scoped owner, is projected
into its owning Audio item, and exposes cancel or retry only for the selected
item.

## Capture presentation hierarchy

`DesktopCaptureService` and the revisioned `ApplicationSnapshot` remain the
only capture truth. One application-scoped main-Renderer controller owns setup,
preflight, recovery, detailed errors, pending commands, and the transient
capture-detail subview. Opening details replaces the current third-column route
content without adding a fourth rail destination; choosing another rail item
closes details without affecting capture.

Active capture is projected into a one-line controller at the global header's
right edge. It contains only state, elapsed time, Pause/Resume, the two-step
Stop and Save action, Open Details, and at most one attention indicator. The
adjacent global activity entry holds at most 30 privacy-safe completion or
actionable-failure items for the current application session. It is not durable
history and never contains a recording title, transcript, path, or raw native
error.

The optional desktop floating controller defaults off and is enabled from
Settings or capture details. Main coordinates one 320 x 72-112 window near the
active display's top-right work area when the main window is no longer
prominent. Closing or pressing Escape suppresses it only for the current
recording; it never stops capture. The window has its own sandboxed Renderer,
minimal Preload, dedicated redacted snapshot, and server-side channel allowlist.
It is visible on normal workspaces but is not promoted above full-screen apps.

In-flow workspace hierarchy uses page canvas, titled sections, separators, flat
rows, and inline alerts. Shadows are reserved for actual overlays, dialogs,
popovers, and the desktop floating controller. A remaining card must represent
an independently actionable object or an explicit semantic boundary.

## Audio and Companion state

Audio selection keys detail-local state. Playback transitions serialize close
then open; a failed switch retains the previous detail, while a successful
switch resets detail-local state. Completed processing jobs do not retain task
chrome.

Companion lists all non-revoked trusted devices, including credential-recovery
rows. Selecting a row changes only the viewed device; it never implies or
initiates a connection. Availability remains unknown unless the protocol has
evidence. With no trusted device, pairing is primary and durable history remains
available as a secondary entry. Transfer state and receipts are filtered by the
selected peer identity.

## Breaking storage and protocol boundary

Electron uses profile `voice2text-electron/v2`, database `audio.sqlite3`, and
fresh schema version 1. Before the fresh database is opened, a regular legacy
development database is timestamp-archived; archive failure blocks opening.
Production code never opens, queries, or migrates that legacy database.

Mobile and Electron use `companion-audio-transfer/v2`, capability
`audio-transfer/v2`, and snapshot version 2. Legacy protocol and IPC payloads
are rejected before Audio mutation. Exact legacy rejection fixtures and frozen
benchmark identifiers are declared in
`audio-activity-source-boundary.json`; no other active source may use the
retired activity terminology.

## Visual evidence

`bun run --cwd apps/desktop-electron test:visual` uses the production Renderer
entry and a typed test-only Electron harness. Current geometry checks cover
the 300 px default pane, 240–480 px resize bounds, the 480 px main-content
minimum, and docked behavior at the 880 px window target. Visual execution and
snapshot updates require explicit authorization for the current task under
`AGENTS.md`; this document does not grant that authorization.

## Release evidence

`docs/product/audio-sidebar-workstation.json` is the current machine-readable
contract. A candidate is valid only when the named Renderer visual command,
behavioral checks, package smokes, and bounded manual checks are bound to the
same committed source and package identity, then finalized without rebuilding.
Historical Electron closure receipts and workstation manifests remain immutable
and are not reused as proof for this composition.
