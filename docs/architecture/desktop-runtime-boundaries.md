# Desktop Runtime Boundaries

## Product boundary

`apps/desktop-electron` is the independent macOS Electron application. It consumes versioned process contracts and compiled Dart/native workers without importing the mobile Flutter application. The retired Flutter Desktop implementation survives only as inert, hash-bound source evidence. Windows is deferred outside the current supported target set and has no PASS.

The desktop app owns its SQLite database under its own application-support directory. Mobile and desktop never copy or share a live database file. Later device exchange must use versioned media, task, and result manifests.

## Local import trust boundary

The system file picker is the only U4 source of local media. The macOS host receives that user-selected path and performs the security-sensitive transfer:

1. Open the source descriptor with `O_NOFOLLOW`; accept only a regular file with one hard link.
2. Read identity and size from `fstat`, reject sparse files, and enforce the configured maximum.
3. Resolve the private destination root, reject symlinked or escaping roots, and generate the destination name in the application.
4. Reserve free space on the destination volume before copying.
5. Copy through the stable descriptor into an exclusive staging file while computing SHA-256.
6. Recheck source identity and size, probe media magic, `fsync`, and atomically rename into `complete/`.
7. Read a positive media duration before returning the committed file to Dart.
8. Commit the recording and processing job in one SQLite transaction. Duplicate hashes reuse the first recording and remove the alternate private copy.

Cancellation, permission failure, invalid format, source mutation, insufficient space, and I/O failure remove staging data and do not create a recording row. Local and future LAN imports must converge on the same post-transfer commit and queue.

Sender paths are never accepted as destination metadata. User-facing names are basename-only, control-character stripped, and bounded. Future LAN metadata must remain bounded and must never supply a filesystem path.

## Processing boundary

U4 installs and resolves the real Sherpa native runtime dependency to falsify the workspace and macOS host early, but no model is product-enabled. Production composition uses `UnavailableDesktopProcessingEngine`, keeps jobs queued, and states that capability is unavailable. It never generates a fake transcript.

Test-only fake engines may claim and complete jobs to validate queue transitions. U5 introduces the versioned `ProcessingEnginePort`, target evidence, and benchmark adapters before any real engine can become product-visible. The first real adapter calls Sherpa 1.13.4 through its C API using Dart FFI, streams Zipformer decoding in bounded chunks, checks cancellation or deadline state between decode steps, applies deterministic PCM silence suppression, and exposes only anonymous, overlap, or unknown speaker assignments.

Sherpa 1.13.4's offline diarization progress callback does not implement cancellation: the native implementation invokes it and ignores the return value. Production diarization therefore runs beyond an isolated worker-process boundary. Timeout or explicit cancellation terminates the worker process group, publishes no partial transcript, and releases the worker's private temporary directory. A direct in-process adapter may be used only by the bounded benchmark and vertical-slice tools; it cannot be composed as the product's cancellable engine.

The command-line benchmark loads the same thinned and signed runtime dylibs that the built app ships. The unthinned pub-cache universal dylib is not evidence: its signature fails verification on this target and macOS terminates it before model loading. Benchmark outputs are bound to OS version, architecture, CPU, memory, signed runtime hash, model hashes, thread configuration, and fixture hashes.

If the process exits while a job is marked `processing`, startup reconciliation changes it to an explicit `PROCESS_INTERRUPTED` failure. No job remains silently stuck.

## Runtime assets and secrets

Model and runtime artifacts are identified by a versioned manifest containing platform, architecture, SHA-256, byte size, license identity/path, content-addressed cache key, and install status. Candidate artifacts do not enter Flutter assets or Git.

API and future pairing secrets use macOS Keychain through the secure-storage adapter. The database and media rely on macOS account isolation and disk encryption; the app does not claim application-level encryption for those files.

## Dependency and support envelope

The root Dart workspace has one lockfile for the mobile app and shared Dart packages. Electron owns its independent `package.json` and `bun.lock` under `apps/desktop-electron`; its native helper and worker resources remain outside ASAR and are hash-verified before use.

The workstation launch target is macOS 13.0. Sherpa 1.13.4's packaged
`libonnxruntime.1.27.0.dylib` still requires macOS 15.5, so it is no longer
linked into the main app process: it is embedded solely for the isolated worker
and local model installation/processing is gated at invocation on macOS 15.5.
Microphone-only capture is available from the macOS 13.0 application floor.
Core Audio process-tap capture is independently gated at macOS 14.2; macOS
13.0–14.1 users see an explicit warning and may continue without system audio.
A clean
Debug Mach-O audit binds the main executable, debug dylib, App.framework and
process-group launcher to 13.0 and confirms that the launch dependency graph
contains no Sherpa/ONNX library. This is a build-contract result; runtime smoke
on macOS 13.x and 14.x remains unverified; the microphone-only path has a
bounded Debug simulation on the current reference target but not lower-OS
target-specific evidence. Historical U4-U9 evidence was
produced on Apple M2; the current U11-U18 and expanded-closure reference target
is Mac mini `Mac16,10` / Apple M4 (10 cores) / 16 GiB / macOS 15.7.5 (24G624).
Historical M2 PASS does not replace current M4 evidence. Other targets remain
unverified.

The desktop v1 operational envelope is frozen at: 4 GiB source bytes, four hours of media, 2 GiB decoded PCM, 200,000 output segments, 20 active queued jobs, one concurrent engine, a 2.25× temporary-storage multiplier, and 2 GiB free after import. Import rejects queue, source-size, duration, and free-space violations without leaving a queued recording or staging artifact.
