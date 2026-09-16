# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Audio Workspace

The interactive editing context for one library audio, combining a persistence-confirmed snapshot with local drafts and selection-scoped playback state.

An Audio Workspace may display newer local intent than its confirmed snapshot. Async completions may change it only while their audio still owns the current selection.

## Authoritative Workspace Snapshot

The last persistence-confirmed state and revision for an Audio Workspace, used to coordinate mutations and synchronize projections such as the detail title and library list.

It is not the same as the user's latest intent while a write is pending; an apparently equal local value can still be a compensating edit.

## Live Registered Audio

An audio newly committed by the recording flow that can become the active Audio Workspace before the ordinary library-list refresh observes it.

Its intent and audio identity protect auto-open from stale list responses and completions that belong to an older selection.
