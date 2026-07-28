# Desktop live meeting capture

The macOS capture boundary is `desktop-capture-session/v1`. The workstation can
launch and record a microphone-only authority track on macOS 13.0. Core Audio
process taps are exposed only on macOS 14.2 or newer, where capture automatically
uses the full system-audio plus microphone mode. Frozen local transcription is
exposed only on macOS 15.5 or newer. Each higher floor is checked when the user
invokes that capability. There is no Android or mobile implementation.

## Authority

In `dual_track` mode, system output and microphone audio are separate immutable
authority tracks. In `microphone_only` mode, the selected microphone is the
complete expected authority set; the absent system track is not reported as a
runtime failure or `partial_capture`.
The system track uses a private Core Audio process tap that excludes this app's
own output. The microphone track uses `AVAudioEngine.inputNode`. Screen pixels,
camera video, meeting-app detection, and automatic start are out of scope.

Flutter sends bounded control messages and receives bounded status events. It
never carries continuous PCM. Captioning reads a disposable, framed, 16 kHz
mono spool and cannot apply backpressure to either authority track.

## State and persistence

The state machine is:

`idle → preflight → preparing → recording ↔ paused → finalizing → completed`

Unexpected termination produces `recoverable`, a single-track failure produces
`partial_capture`, and an unrecoverable dual-track failure produces `failed`.
Pause freezes the monotonic capture timeline. Repeated start, stop, finalize,
and recovery calls use a stable session ID and idempotency key.

Each active track is stored in independently finalized five-second CAF chunks. A
write-ahead journal records the relative path, monotonic time range, byte count,
and SHA-256 only after the chunk is durable. Recovery validates finalized
chunks, quarantines at most one incomplete tail chunk per track, and never
deletes a valid chunk without an explicit user discard action.

The caption spool uses 100 ms framed `s16le`, 16 kHz, mono batches. It is
derived, bounded, and deleted after recording commit and caption-worker
shutdown.

## Permission and failure semantics

`NSAudioCaptureUsageDescription` and `NSMicrophoneUsageDescription` are
independent. Preflight reports not-determined, granted, denied, restricted,
revoked, and unavailable without conflating the two permissions.

A missing caption model disables captions only. On macOS 13.0–14.1, preflight
shows an explicit compatibility warning and the start action says that only the
microphone will be recorded. Missing microphone permission, no microphone, or
insufficient disk blocks start. During recording, device
disconnect, permission revocation, format change, low disk, and encoder failure
become monotonic events. A healthy track continues and the session is visibly
partial; caption failure never changes authority-track frame or chunk counts.

The frozen development probe parameters are recorded in
`benchmark/desktop/capture/macos_capture_feasibility.json`. A capability cannot
advance past `PLANNED` without current Mac mini `Mac16,10` / Apple M4 /
16 GiB / macOS 15.7.5 (24G624) evidence.
