# SenseVoice live-caption benchmark

This directory contains the DEVELOPMENT_ONLY Apple M4 live-caption contract.
It measures completed VAD utterances; it never reports token streaming.

The fixture builder downloads only the selected CC-BY-4.0 FLEURS rows into a
local cache, verifies the pinned dataset revision, and writes a hash-bound
manifest. Audio remains local and is never packaged with the application.
Deterministic far-field, keyboard-noise, phrase-level language-switch and
double-talk transforms are disclosed in the manifest. Repeated 15-minute input
is used only for stability and never for quality ranking.

Every benchmark invocation is limited to 30 minutes. The U13 control keeps the
2024 SenseVoice int8 model, sherpa-onnx 1.13.4 / ORT 1.27, CPU, two threads,
language `auto`, ITN disabled, one resident recognizer, Silero VAD and a
15-second maximum utterance. U18 completed all 13 single-variable arms and
retained that control after held-out and bounded stability validation.
