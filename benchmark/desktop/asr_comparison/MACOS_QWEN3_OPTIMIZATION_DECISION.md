# macOS Qwen3 optimization decision

Status: `OPTIMIZATION_ADMITTED`

The fixed evaluator selected `vad-max-speech-12` on the current Mac mini
`Mac16,10` / Apple M4 / 16 GiB / macOS 15.7.5 (24G624). The frozen product
profile remains Qwen3-ASR 0.6B int8, sherpa-onnx 1.13.4 / ORT 1.27, CPU two
threads, concurrency one, empty hotwords, and `maxNewTokens=512`; it replaces
fixed 15-second chunking with official Silero VAD at `threshold=0.2`,
`minSpeech=0.2`, and `maxSpeech=12` seconds.

The selected arm reduced aggregate error rate from `0.2253808684` to
`0.2006049341` and non-target error rate from `0.2675416883` to
`0.2401178697`, while target-term recall rose from `0.75` to `1.0`. Its RTF was
`0.2067832897`, P95 segment latency was `5130.81 ms`, and it passed the frozen
RSS, cancellation, temporary-file, truncation, and hallucination gates.

All eight preregistered arms completed. ORT 1.24.4 was substantially faster
(`RTF=0.0943867176`) and quality-qualified, but the fixed evaluator selects the
lowest admitted error rate, so the runtime remains ORT 1.27. The dynamic
hotword arm regressed non-target error. The 128-token arm reported truncation
and is ineligible; 256 tokens produced no quality advantage. The derived
12-second VAD arm passed its required `vad-official-20` parent gate.

The fixed bindings are:

- contract: `4d733fea306dfa49dc9c1f517103011e60050a4581f9558c348fbafb93a209fe`
- fixture manifest: `c0ee7d2652bb8b3bbdf12fc77bdb98be0b10c125458efb19a9e326a4ddf665ce`
- scorer: `4ff8a22f5a1184fb0cf09e6c9f30427fe6e7171827c7db98c9640c5a8108dbf7`
- matrix: `c18227ceaef08922dcdff761e56d7792d6bb8f9d79183cd9ea500deed8d3ac76`
- raw manifest: `2e18866017ccf97e2331e3dbec042d1e536145ede741da4f4fb2c2086dabdb01`
- summary: `aacac87d2418f12e467f06d639fbd3a72b922de3d01eecb8e2f2a6ebf06c61f8`
- decision: `408e264bbb68fb30ad6d860f8ded69db4a50d09e29956c392c37c9ea3335750d`
- product worker smoke: `059c1bc8644e94824ee90e6ffd2b108f6938afedbaa72891ac14f645a5eddf0d`

This is a `DEVELOPMENT_ONLY` admission. It does not authorize distribution,
signing, notarization, store submission, or production release work.
