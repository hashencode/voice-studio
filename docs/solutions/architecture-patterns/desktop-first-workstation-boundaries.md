# Desktop-first meeting workstation boundaries

## Context

The repository keeps the Android mobile core at the root while adding a desktop
meeting workstation under `apps/desktop`. Both products share data contracts and
workflows without making either application package depend on the other.

## Boundary pattern

Keep platform applications as composition roots and move only portable contracts
into workspace packages:

- `meeting_core` owns domain values.
- `meeting_storage` owns the shared SQLite schema and migrations.
- `processing_contracts` owns processing job/result contracts.
- `meeting_workflows` owns revision, export, and recovery behavior.
- The root app composes Android capture and mobile capabilities.
- `apps/desktop` composes file import, native workers, desktop playback, review,
  LAN receive, Keychain, and macOS-specific security truth.

This prevents the desktop app from importing the mobile package and avoids
turning a shared package into a hidden platform service locator.

## Native work as a process boundary

Long-running native inference should not execute in the UI process. The desktop
app starts a versioned worker through a process-group launcher, supplies a
minimal fixed environment, and publishes results only after the whole logical
job succeeds. Cancellation terminates the process group and discards partial
output.

For a two-hour meeting, one Sherpa diarization worker exceeded the product time
budget even though the model was admissible. The product solution uses two
2-thread workers with a bounded overlap:

1. Split at a stable midpoint.
2. Include enough overlap on both sides to observe common speakers.
3. Align anonymous speaker labels using overlap evidence.
4. Cut both results at the midpoint to prevent duplicate turns.
5. Publish the joined result atomically under the original job.

Shard count, thread count, overlap, clustering threshold, runtime, and model
hashes are product configuration and evidence—not tuning knobs exposed in UI.

## Evidence is target-specific

A platform PASS is valid only for the target fingerprint and artifact set that
produced it. Store OS, architecture, CPU, memory, runtime/model/fixture hashes,
threading, quality, latency, resource use, and recovery outcomes together.
Windows may reuse the frozen finalist design, but it cannot inherit macOS PASS.

Make closure machine-verifiable. A validator should bind:

- upstream unit evidence hashes;
- packaged worker/runtime hashes;
- long-meeting and quality thresholds;
- interaction, lifecycle, security, accessibility, and LAN outcomes;
- the target-specific terminal disposition.

This keeps prose status pages descriptive while the manifest and validator
remain authoritative.

## Lifecycle and security truth

Separate committed meeting data from transient transport and processing data:

- staging, sidecar, and ephemeral share data have a 24-hour retention bound;
- interrupted LAN checkpoints have a 7-day retention bound;
- receipt deletes transfer payload immediately;
- unpair deletes trust and transfer metadata without deleting the committed
  meeting;
- cleanup never follows symlinks.

Do not imply encryption that the app does not provide. On macOS, probe FileVault
with the platform tool, disclose that database/audio files have no app-layer
whole-store encryption, and prompt when FileVault is disabled or unknown.
Keychain protection for API and pairing secrets is a separate guarantee.

## LAN handoff ownership

LAN media transfer is distinct from the structured-notes provider protocol.
Pairing binds both identities; each session derives directional authenticated
encryption keys; monotonic counters reject replay; resumable chunks are retained
only until receipt or expiry. Source deletion must never happen before a
verified receipt, and the default mobile behavior is to retain the source.

## Verification consequence

Routine checks can validate contracts and recorded hashes, but evidence-producing
physical gates remain explicit. A closure is complete only after the real target
integration suite, final long-meeting run, dogfood review, privacy checks, build,
and repository-wide tests all pass against the same frozen source and artifacts.
