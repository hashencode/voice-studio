# Electron Audio context shell

This document describes the current Electron desktop composition. The earlier
Earlier workstation closure records are historical evidence; they do not define
the active Audio/sidebar-09 product or prove its release candidate.

## Navigation and ownership

The permanent rail has exactly three destinations, in order: `audio`
(`音频`), `companion` (`互联`), and `settings` (`设置`). Audio owns record,
import, search, list, selected detail, playback, editing, intelligence, export,
and processing actions. There is no standalone task or library route.

Audio and Companion each own an independent context-pane preference. A pane is
docked at supported widths and becomes a non-modal drawer at 880 px. Resizing,
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

## Release evidence

`docs/product/audio-sidebar-workstation.json` is the current machine-readable
contract. At U5 it deliberately says that release validation is pending. U6
must build one committed candidate, bind automated and manual results to the
same source/package identity, and finalize without rebuilding. Historical
Electron closure receipts and workstation manifests remain immutable and are
not reused as proof for this composition.
