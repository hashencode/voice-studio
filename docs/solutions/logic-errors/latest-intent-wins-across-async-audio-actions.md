---
title: Latest intent must survive async audio workspace operations
date: 2026-09-16
category: logic-errors
module: apps/desktop-electron renderer
problem_type: logic_error
component: frontend
symptoms:
  - "Changing a title from A to B and back to A while B is saving can persist B instead of the latest A."
  - "Deleting an older selection can clear a different recording that auto-opened while deletion was pending."
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - messaging
  - service_layer
tags:
  - async-state
  - latest-intent-wins
  - optimistic-ui
  - audio-metadata
  - navigation-race
---

# Latest intent must survive async audio workspace operations

## Problem

The audio workspace accepts optimistic metadata edits while persistence is asynchronous. A displayed value can therefore equal the last confirmed snapshot even though an older write is still in flight. That equality describes persisted history, not necessarily the user's latest intent.

Destructive work has the inverse hazard: after an `await`, completion still belongs to the originally targeted audio, while the visible workspace may now belong to another audio.

## Symptoms

- Before this fix, a user could change a title from A to B, restore A before the B save resolved, and lose the restoring write because equality with the stale authoritative value returned before queueing it.
- Before this fix, deletion cleanup used selection captured at the start of the request, so completion could clear a recording that auto-opened while deletion was pending.

The regression tests reproduce both orderings in `apps/desktop-electron/tests/unit/renderer/audio_route_test.tsx:69` and `apps/desktop-electron/tests/unit/renderer/audio_route_test.tsx:1651`.

## What Didn't Work

- Comparing a draft only with the last authoritative value conflated “nothing needs to be sent” with “the desired value matches an old snapshot that an in-flight request is about to replace.”
- Serializing requests was necessary but insufficient. A later intent still had to be retained as a compensating write for the serializer to execute.
- Capturing selection before asynchronous deletion proved only who owned the UI at the start. It said nothing about ownership after playback close and deletion completed.

## Solution

Track pending persistence separately from dirty state. The save path now treats equality as a no-op only when the field has no pending save:

```ts
if (
  value === authoritativeValue &&
  !metadataSavePendingRef.current[field]
) {
  metadataDirtyRef.current[field] = false;
  return;
}
```

The pending flag is field-specific and completion clears it only when the request version still matches the field's latest version (`apps/desktop-electron/src/renderer/features/audios/audio-workspace-feature.tsx:438`, `apps/desktop-electron/src/renderer/features/audios/audio-workspace-feature.tsx:651`). This allows an A → B → A edit to stage A behind the in-flight B write.

The route controller stages patches per audio ID and drains them until no draft remains. Each write uses the revision returned by the preceding write. On failure, the failed patch is merged with drafts added during the request and staged again, with newer values winning when both patches change the same field (`apps/desktop-electron/src/renderer/features/audios/audio-route-feature.tsx:376`).

For destructive completion, re-read the current owner after the await. Deletion removes the targeted audio from the list, but clears workspace and playback state only if the current workspace still has the deleted audio ID (`apps/desktop-electron/src/renderer/features/audios/audio-route-feature.tsx:851`).

## Why This Works

Two independent facts determine whether an edit is complete:

- The authoritative snapshot says what persistence has confirmed.
- Pending-operation state says whether that snapshot is about to become stale.

A no-op decision is valid only when both agree. While a request is pending, restoring an old-looking value is a real compensating write and must survive until the earlier request establishes the revision for it.

The same ownership rule applies after destructive awaits: the completed operation may update data for its target, but it may mutate selection-scoped UI only if that target still owns the current workspace. This prevents an older completion from overriding a newer intent.

## Prevention

- Model confirmed value, pending request, and latest intended value separately for optimistic fields.
- Never use equality with the confirmed snapshot as the sole no-op test while writes can be in flight.
- Serialize writes by resource identity and retain compensating edits until the queue drains.
- After every await that can overlap selection, navigation, deletion, or auto-open, re-read the current owning identity before clearing or replacing UI state.
- Test adversarial orderings with deferred promises: same-field A → B → A, and old destructive completion after a new selection becomes active.
- On failure, restore or requeue user intent instead of silently discarding it.

This change was verified with the repository's nonvisual Electron code gate. Visual validation was not run because this task did not authorize it.

## Related Issues

- [Desktop-first meeting workstation boundaries](../architecture-patterns/desktop-first-workstation-boundaries.md) provides adjacent context on desktop ownership and lifecycle boundaries.
