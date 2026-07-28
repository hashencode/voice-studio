# macOS capture feasibility

Status: `PASS`

On 2026-07-28, the available Apple M4 / 16 GiB / macOS 15.7.5 host completed a
real dual-track Debug smoke after the user granted system-audio and microphone
access. The private Core Audio process tap completed start, pause, resume and
stop in one attempt and observed 146,944 stereo frames at 48 kHz while the
independent external-headset microphone observed 144,000 mono frames at 48 kHz.
The hash-bound result is
`evidence/macos_m4_dual_track_smoke.json`.

The declared U11-U18 and expanded-closure target is now this Mac mini
`Mac16,10` / Apple M4 (10 cores) / 16 GiB / macOS 15.7.5 (24G624), so the short
smoke is admissible target-specific API evidence. It does not by itself unlock
U12 because it does not exercise durable chunking, fault injection, or recovery.

The workstation launch target is macOS 13.0. The Core Audio tap API is gated at
invocation on macOS 14.2, while frozen local transcription is independently
gated at macOS 15.5. Sherpa/ONNX is embedded for the isolated worker but is not
linked into the app launch dependency graph. The contract uses a private process
tap excluding this app's output and an independent `AVAudioEngine.inputNode`
microphone track. It records no screen pixels. This lower-floor result is
Mach-O/build-contract evidence and does not claim a physical macOS 13.x/14.x
smoke.

The registered 20-minute development probe completed on the current M4 target.
It wrote 240 independently finalized five-second CAF/LPCM chunks per authority
track (480 total), observed 57,596,416 system-audio frames and 57,585,600
microphone frames, and used 704,747,557 bytes. All finalized hashes validated.
Completed-session recovery took 326 ms. The pre-registered `during_write`,
`during_finalize`, and `after_journal` injections were idempotent, and recovery
quarantined no more than one tail chunk per track. The hash-bound result is
`evidence/macos_m4_20m_chunk_recovery_probe.json`.

The U11 contract is frozen and U12 is allowed to proceed. Historical one-hour
and two-hour recordings remain baseline-only and were not rerun.
