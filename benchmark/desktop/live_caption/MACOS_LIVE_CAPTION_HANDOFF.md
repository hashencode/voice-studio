# macOS live-caption handoff decision

U14 is admitted for the current development target: Mac mini `Mac16,10`,
Apple M4, 16 GiB, macOS 15.7.5 (24G624). This is development evidence only
and does not authorize signing, notarization, distribution, or release work.

The native capture boundary now writes the two immutable authority tracks and
a disposable 16 kHz mono spool. A bounded 10-second physical-machine smoke
produced independent system and microphone CAF chunks plus 97 complete
100-millisecond spool frames. The short probe intentionally does not replace
the historical U11 long-duration evidence.

The U18-retained SenseVoice worker consumed the real spool through the U14
resident JSONL protocol, emitted two contiguous finalized utterances, advanced
its durable offset to exactly 310,400 bytes, and finished with zero backlog.
Flutter never transported continuous PCM.

Schema v23 stores the live session, generation, sequence, language, model hash,
and worker offset. Replayed events are idempotent; gaps, timestamp overflow,
generation drift, model drift, and backwards offsets fail closed. The stop
workflow commits capture before closing captions and enqueuing the frozen U17
Qwen3 profile. Incomplete formal output cannot switch active authority. A
human-edited draft or prior generation remains selected until an explicit,
reversible reconciliation choice.

Evidence is frozen at
`evidence/handoff/macos/u14-handoff-smoke.json`.
