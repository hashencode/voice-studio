# macOS SenseVoice live-caption control decision

U13 admits the frozen SenseVoice control for local development on the current
reference target only: Mac mini `Mac16,10`, Apple M4, 16 GiB, macOS 15.7.5
(`24G624`), arm64, Debug. This is not a production-distribution decision and
does not transfer to Intel, 8 GiB, Windows, or another macOS fingerprint.

The admitted control is the 2024-07-17 SenseVoice int8 model with
sherpa-onnx 1.13.4 / ORT 1.27.0, CPU, two threads, concurrency one,
`greedy_search`, language `auto`, ITN disabled, Silero VAD threshold 0.5,
minimum speech 0.25 seconds, minimum silence 0.5 seconds, and a deterministic
15-second hard split. It publishes completed utterances only; it does not
claim token streaming.

The fixed 15-minute physical replay produced speech-end-to-Flutter-visible
P50 900.901 ms and P95 1492.201 ms, a maximum 0.528-second backlog, no
crash/OOM, and no utterance longer than 15 seconds. A separate two-minute
App-Sandbox integration probe measured actual Flutter frames and compared a
one-minute capture-only control with a one-minute concurrent SenseVoice run.
Both system-audio and microphone callback frames matched durable committed
frames exactly, so the concurrent capture loss delta was zero. Conservative
Flutter plus worker RSS was 1,318,420,480 bytes and the sampled UI long-frame
rate was zero.

The machine-readable decision is
`evidence/macos/u13-control-decision.json`. It binds the frozen contract,
fixture manifest, scorer, raw replay, Flutter/capture probe, and evaluated
summary by SHA-256. U18 completed and retained this control after the screened
VAD threshold candidate failed held-out quality guardrails. U14 consumes
`evidence/sensevoice-optimization/macos/u18-decision.json`.

If live-caption processing crashes, emits an invalid or oversized event,
falls behind the bounded queue, or is unavailable on the current OS, raw
dual-track capture remains authoritative and continues without backpressure.
The UI must mark the draft unavailable rather than invent partial tokens or
promote the draft to the formal transcript.
