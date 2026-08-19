# Electron Audio context shell

This document describes the current Electron desktop composition. Earlier
workstation closure records are historical evidence; they do not define the
active Audio/sidebar-09 product or prove its release candidate.

## Visual authority and composition

The shell follows shadcn's `sidebar-09` block at commit
[`25be24cca34d06eed29a4779c3f48c4816aa812c`](https://github.com/shadcn-ui/ui/tree/25be24cca34d06eed29a4779c3f48c4816aa812c/apps/v4/registry/new-york-v4/blocks/sidebar-09).
One `SidebarProvider` owns a 350 px outer Sidebar. Its first nested Sidebar is a
48 px icon rail plus a 1 px divider; its second nested Sidebar fills the
remaining 301 px context pane. The main workspace is the only `SidebarInset` and
owns the sticky bordered header. The wrapper, fixed container, rail, context
pane, and inset are constrained to the viewport so business content scrolls
inside its own region instead of stretching the rail.

Voice2Text deliberately replaces the block's mail demo, account switcher, and
mail list with its three product destinations, Audio/Companion context panes,
and existing business workspaces. Those surfaces still use the block's token,
density, flat-row, focus, and control grammar. Product behavior remains the
authority where it differs from the demo: the context pane docks at 1024 px and
above, becomes a non-modal overlay below 1024 px, keeps a 48 px layout gap, and
preserves independent Audio and Companion preferences.

## Navigation and ownership

The permanent rail has exactly three destinations, in order: `audio`
(`音频`), `companion` (`互联`), and `settings` (`设置`). Audio owns record,
import, search, list, selected detail, playback, editing, intelligence, export,
and processing actions. There is no standalone task or library route.

Audio and Companion each own an independent context-pane preference. A pane is
docked at 1024 px and above and becomes a non-modal overlay below 1024 px,
including the fixed 880 px verification target. Resizing,
changing destinations, and selecting list items do not mutate either
preference. Only an explicit pane action changes it. Settings has no context
pane and does not overwrite the other destinations' preferences.

Each main workspace exposes one meaningful level-one heading. Destination
changes move focus to the destination heading or named primary control.
Capture and recovery remain app-level surfaces, so the non-modal drawer cannot
make either one unreachable. Processing has one app-scoped owner, is projected
into its owning Audio item, and exposes cancel or retry only for the selected
item.

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
entry and a typed test-only Electron harness. It fixes locale, color scheme,
motion, time, DPR, and viewport, then asserts full-height rail geometry, 350 px
docked composition, 48 px overlay gap, 301 px context-pane bounds, flat context
rows, and capture-controller containment. Five canonical macOS arm64 images
cover Audio open, Audio closed, Settings, 880 px recovery, and multiple
Companion devices. Snapshot updates are evidence changes, not routine test
maintenance, and require manual comparison with the pinned official demo.

## Release evidence

`docs/product/audio-sidebar-workstation.json` is the current machine-readable
contract. A candidate is valid only when the named Renderer visual command,
behavioral checks, package smokes, and bounded manual checks are bound to the
same committed source and package identity, then finalized without rebuilding.
Historical Electron closure receipts and workstation manifests remain immutable
and are not reused as proof for this composition.
