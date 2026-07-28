# SenseVoice optimization evidence

This directory contains only evidence bound to
`sensevoice-live-caption-optimization/macos-m4/v1` on Mac mini `Mac16,10` /
Apple M4 / 16 GiB / macOS 15.7.5 (24G624).

`screening-raw.json` and `screening-summary.json` cover the control plus 13
single-variable arms. `finalist-raw.json` and `finalist-summary.json` cover the
screened `vad-threshold-0.4` candidate on held-out fixtures plus a 15-minute
real-time replay. `u18-decision.json` re-evaluates those files, binds the U13
control and Flutter/capture probe, and resolves to `CONTROL_RETAINED`.

Audio and model files remain local-only and are never committed here.
