# Apple M4 Qwen3-ASR Official RTF Reproduction and Attribution

Publication ID: `e1e17b6e6f01fb06b2a9e558`  
Bounded evidence SHA-256: `be8ebfc8a995b3ef0015082498212538192ff906fa79eca1b965686df20e762e`  
Builder SHA-256: `e1aa7ea4c2225b20447d14f348f22a871db423dabfd84e979d32ba8f27472bad`  
Runner SHA-256: `ebbedea801e2c1a8a2e1e3d07831c49217d3ce65257b779decf98c63c7399814`

## Decision

The official RTF point is **not reproduced within tolerance** under the explicit ±10% rule. The best local native lane was `native-v1.13.4-ort1.24.4-diagnostic` at median RTF **0.1242**, **1.206×** the official 0.103. Official hardware and complete build flags remain unknown, so this does not prove a regression against the official implementation.

On the same M4 and sherpa-onnx 1.13.4 source lane, ORT 1.27.0 / ORT 1.24.4 is **2.061×** by median official-comparable RTF. The predeclared regression threshold is 1.50×; threshold met: **true**.

No product model, product worker, diarization path, UI, or frozen ranking changed.

## Official control

The [official sherpa-onnx Qwen3-ASR page](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html) reports Obama.wav as 334.234 seconds, 34.480 seconds elapsed, and RTF 0.103. The [public audio asset](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/Obama.wav) and model/VAD assets remained local-only and are hash-bound in the JSON. All strict lanes use CPU, 2 threads, int8, max total/new tokens 512, temperature 1e-6, top-p 0.8, seed 42, empty hotwords, and Silero threshold 0.2/min speech 0.2 s/max speech 20 s.

The v1.12.34 lane is only a page-era proxy: it introduced Qwen3-ASR, but the page does not bind its number to that binary. The unmodified official archives are retained by hash; executed copies were locally ad-hoc signed after macOS provenance/signature enforcement. The JSON separately binds the archive, original CLI/dylibs, and exact executed CLI/dylibs.

## Same-machine results

Values are median / P95. Native `decodeMilliseconds` is the official CLI elapsed value and indivisibly includes VAD, decoding, and file processing after load. Dart `decodeMilliseconds` is the worker decode phase (stream setup, accept, decode, result conversion, free) and excludes segmentation/VAD. `endToEndWallMilliseconds` is input-to-first-result; `processWallMilliseconds` is spawn-to-complete/exit. Official-comparable Dart VAD processing is VAD + decode.

| Lane | Warm+measured | Official-comparable RTF | Decode ms | Input→result ms | Process wall ms | Peak RSS GiB |
|---|---:|---:|---:|---:|---:|---:|
| `native-v1.12.34-ort1.23.2-page-era` | 1+5 | 0.1329 / 0.1348 | 44424.0000 / 45045.0000 | 46028.6141 / 46784.9035 | 46184.2942 / 46951.4010 | 3.0015 / 3.0172 |
| `native-v1.13.4-ort1.24.4-diagnostic` | 1+3 | 0.1242 / 0.1243 | 41509.0000 / 41534.0000 | 43208.6091 / 43276.0688 | 43418.2720 / 43419.4196 | 3.6752 / 3.7344 |
| `native-v1.13.4-ort1.27.0-current` | 1+5 | 0.2559 / 0.2587 | 85534.0000 / 86478.0000 | 87107.6031 / 88026.5179 | 87265.2717 / 88173.5381 | 3.1062 / 3.2884 |
| `dart-v1.13.4-ort1.27.0-fixed15-current-worker` | 1+5 | 0.2514 / 0.2520 | 84038.6910 / 84232.0990 | 90569.0685 / 90754.2334 | 91614.7168 / 91801.4946 | 2.6324 / 2.6855 |
| `dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker` | 1+5 | 0.2557 / 0.2617 | 85477.6860 / 87470.5190 | 86798.0465 / 88812.9855 | 87841.8790 / 89860.2800 | 2.6726 / 2.6978 |
| `dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker` | 1+5 | 0.2535 / 0.2624 | 84012.3500 / 86941.9400 | 86074.8715 / 89079.7590 | 87120.4204 / 90136.3324 | 3.1594 / 3.3513 |

Whole-audio Dart input is `not_applicable` (`max_total_len_512_long_input_context_not_safe`).

### Phase, segment, and output metrics

Values are median / P95. “Worker decode phase” is not a kernel-only recognizer timer: for Dart it includes stream setup, waveform acceptance, decode, result conversion, and stream free; for native it is unsupported because the official CLI elapsed interval is indivisible. Segment P50/P95 is per-segment processing wall time, not audio duration.

| Lane | Load ms | Worker decode phase ms | Segment P50 ms | Segment P95 ms | VAD ms | Output tokens | Tokens/audio s | Result conversion ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `native-v1.12.34-ort1.23.2-page-era` | 1609.0832 / 1727.6257 | unsupported (native_cli_elapsed_is_indivisible_processing_time) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_elapsed_includes_vad_indivisibly) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_expose_conversion_timer) |
| `native-v1.13.4-ort1.24.4-diagnostic` | 1663.9597 / 1779.8465 | unsupported (native_cli_elapsed_is_indivisible_processing_time) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_elapsed_includes_vad_indivisibly) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_expose_conversion_timer) |
| `native-v1.13.4-ort1.27.0-current` | 1558.6424 / 1589.7006 | unsupported (native_cli_elapsed_is_indivisible_processing_time) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_does_not_emit_detector_latency) | unsupported (native_cli_elapsed_includes_vad_indivisibly) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_emit_token_census) | unsupported (native_cli_does_not_expose_conversion_timer) |
| `dart-v1.13.4-ort1.27.0-fixed15-current-worker` | 1125.2920 / 1129.7270 | 84038.6910 / 84232.0990 | 3752.5900 / 3779.9420 | 4016.9140 / 4125.4190 | unsupported (current_worker_has_no_segmentation_timer) | 1004.0000 / 1004.0000 | 3.0039 / 3.0039 | unsupported (current_worker_has_no_conversion_extension) |
| `dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker` | 1111.8060 / 1215.0200 | 85477.6860 / 87470.5190 | 3785.8710 / 3942.8950 | 4149.7530 / 4558.8680 | 0.0010 / 0.0010 | 1004.0000 / 1004.0000 | 3.0039 / 3.0039 | 0.6780 / 0.6900 |
| `dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker` | 1176.4700 / 1201.8410 | 84012.3500 / 86941.9400 | 5351.4190 / 5476.2250 | 5903.2000 / 6309.5320 | 717.3850 / 751.3620 | 987.0000 / 987.0000 | 2.9530 / 2.9530 | 0.5890 / 0.6430 |

### Memory metrics

Values are median / P95 GiB. Native retained RSS is `not_applicable` after process exit; unsupported metrics are never represented as zero.

| Lane | Absolute peak | Incremental peak | Retained after unload |
|---|---:|---:|---:|
| `native-v1.12.34-ort1.23.2-page-era` | 3.0015 / 3.0172 | 2.9999 / 3.0156 | not_applicable (native_process_has_exited) |
| `native-v1.13.4-ort1.24.4-diagnostic` | 3.6752 / 3.7344 | 3.6736 / 3.7328 | not_applicable (native_process_has_exited) |
| `native-v1.13.4-ort1.27.0-current` | 3.1062 / 3.2884 | 3.1046 / 3.2869 | not_applicable (native_process_has_exited) |
| `dart-v1.13.4-ort1.27.0-fixed15-current-worker` | 2.6324 / 2.6855 | 2.5921 / 2.6437 | 1.1446 / 1.3087 |
| `dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker` | 2.6726 / 2.6978 | 2.6498 / 2.6749 | 1.1406 / 1.2467 |
| `dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker` | 3.1594 / 3.3513 | 3.1363 / 3.3281 | 1.0911 / 1.4196 |

## Attribution

The segmentation comparison uses the same diagnostic worker on both sides and the median of five interleaved same-index pair ratios: official Silero / fixed-15 official-comparable processing RTF is **1.0025×**. The five pair ratios and P95 are published in JSON. The current-worker fixed lane is retained as a separate implementation control and is never used to claim segmentation cost.

Diagnostic result conversion is **0.000701%** of diagnostic VAD decode. Native CLI pure recognizer decode, detector segment census/latency, token count, and conversion timers are unsupported—not zero. Native stdout timestamps are reported only as emitted-result segment metrics, not as detector census.

The 20 ms sampler-off / sampled ratio is **1.0112×**, but the small, non-interleaved probe cannot identify exact causal overhead. It is only sufficient to rule out RSS sampling as an approximately 2× explanation. Thread probes are diagnostic and not mixed into the two-thread comparison.

## Prior 84–88 second result

The earlier 84–88 second values were decode times for approximately six-minute fixtures, not 15-second audio. RTF, not whole-fixture wall time, is the official speed comparison.

## Root-cause order and actions

1. ORT/runtime build lane: the same-source ratio is 2.061×.
2. Unknown official hardware/build: the residual official comparison is not hardware-attributable.
3. Segmentation: same-worker controlled ratio 1.0025×.
4. FFI/JSON: measured conversion share 0.000701%.

Bisect ORT 1.24.4→1.27.0 under identical compiler flags; validate any older-ORT diagnostic pin for accuracy, stability, and memory before product consideration; keep segmentation and thread experiments outside frozen ranking.

## Diagnostic thread probe

These single observations are non-ranked and have no per-thread confidence interval.

| Threads | RTF | CLI elapsed ms | Absolute peak RSS GiB |
|---:|---:|---:|---:|
| 4 | 0.1672 | 55888.000 | 3.2072 |
| 6 | 0.1886 | 63039.000 | 3.2757 |
| 8 | 0.1679 | 56134.000 | 3.4059 |

## Runtime, build, and hash closure

The original archives and original extracted files were retained byte-for-byte. Separate ad-hoc-signed copies were executed after macOS provenance/signature enforcement terminated the downloaded binaries. `executed` hashes identify what ran; `original` hashes preserve upstream identity. Complete prebuilt compiler flags are unavailable and explicitly marked unsupported.

| Lane | sherpa version / git | ORT | Archive SHA-256 | Executed CLI / sherpa C API / ORT SHA-256 | Original CLI / sherpa C API / ORT SHA-256 | Build flags |
|---|---|---|---|---|---|---|
| `native-v1.12.34-ort1.23.2-page-era` | 1.12.34 / `12e81142` | 1.23.2 | `65ed4f3784406163e505694c39acb507f5d4bd1b2b9e6cef23f00d3c4a81b40f` | `8278cc4f4eb1d734cf41d7ca8a01f6ae4a72d18a22547f743ba7f44def29f4ee` / `9f1a6e3521b09bd79635f145f2f66f4a39af5378e73f922b04728bb2d17e4237` / `41275ae6aadfa5be4ed64a880c994d8015e1f43910e3a74fc03385ce2947a2b4` | `d4408f55395419736988df21864c7853d48644f2c0a459115e01d183b967dc44` / `cf70eff5fb1c787b15d8bf29fa7c4c8b9d14abf19e7142ed30cbfb55d40add69` / `0708038eff766aed5559989aa0710d45546c469dc1bf85c6e83d603a98c10ae9` | unsupported (prebuilt_archive_does_not_publish_complete_flags) |
| `native-v1.13.4-ort1.24.4-diagnostic` | 1.13.4 / `14280725` | 1.24.4 | `cb4198f8dee474d16e3ff98a4cd2448e3a9a10195a4809e13b738934beab4aad` | `156b16945868b2bbaca3a7c049e99adde183c1a58ed692a223949279fde548cc` / `7452470ad7539908c8de6ab53cc9d63e93d28277de746d91a4d1e2469f223f27` / `6c057f7597518368fead4be5f4246824750148b67eccf98c912db64209d8b164` | `1a9857b1e8848d20be83ea94c2b903b4d04f3c2929a6ef0867b842ddf5e7defa` / `f33688e3fea2c8ac401380da9cc3a295a9ac6a646c0f5541204ae5529e8844bb` / `872533f130f1839a5bc01788ddb4f75c83a189763441ba1178788ed965449289` | unsupported (prebuilt_archive_does_not_publish_complete_flags) |
| `native-v1.13.4-ort1.27.0-current` | 1.13.4 / `14280725` | 1.27.0 | `809ab5d0c77bd8f358364a244e6ab17f2afecf9779eb9fd436fa469c3ff5375c` | `145f7cbcbe4eee0945d889a6d22602f8a3fb87f1637bee9b4ab6bd9984ddbc3e` / `2f7eeb755a58e4e2cb6bae5070ed601a0c9f20fb32a6d269be82cffc17069496` / `245b4897245c6da8d679b88e68cb7b40a6e3f68fc714070c8ea36eac6916d8ef` | `71413f6611a96c3f9eb6a322c6186443dca84f43f9d3f7d3bf86aaacaa9b6e95` / `444d48d329254a1839ac304cc38475041076b70fa35f1aaf8540e5614fa09e33` / `8e822d761fac13e47c6725baf1e65d9858ea00bf0af3e61a43b7c6a65a794439` | unsupported (prebuilt_archive_does_not_publish_complete_flags) |

Dart executed runtime:

- sherpa C API: `102e8383640a6752dc9c51060836aba6f3da75bd644c3ddada1a0c15b8df0f02`
- ORT 1.27.0: `e9d56d076c79ddcd029a0d4fc80c7ec9887ea16235b770f9f99db2251b535e43`
- current worker: `6019e0d020d26d4176d9af6e283c22cfc2756a994b7ce1533f02529191451e16`
- current sandbox launcher: `822a99cceb6cf7c50ee2b7ee1a5aa6042d3fe2e976f1ff12ce473a33a4335ddf`
- current process-group launcher: `ee149a57fb5ffb41581049aff36835c6f2288682dbc66db5965139fb691fc50c`
- diagnostic worker binary: `736481bbe4e59ab3d49f77bfcae427813a396b44021c670f9edda6d6a831a70d`
- diagnostic worker source: `36fd264436897a4e41b1c5ff4a0aabb5e7f5b7b5fa4f2f4320f0ac4f776f8760`
- diagnostic sandbox launcher: `822a99cceb6cf7c50ee2b7ee1a5aa6042d3fe2e976f1ff12ce473a33a4335ddf`
- diagnostic process-group launcher: `ee149a57fb5ffb41581049aff36835c6f2288682dbc66db5965139fb691fc50c`
- resource sampler: `9437034c4d4a25c4235256b0b2e14eeb39b6195de53a687ac7f93f0301eeeea4`

Assets:

- official audio SHA-256: `77b34b85923c7cb3e82670b8afc70b5d2dfce0477769c6bfa85d2722701c6d57`
- official audio disposition: `ACCEPTED_LOCAL_ONLY_UPSTREAM_PUBLIC_EXAMPLE_NO_AUDIO_REDISTRIBUTION`
- Silero VAD SHA-256: `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`
- `convFrontend`: `d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e`
- `decoder`: `4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771`
- `encoder`: `60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9`
- `sileroVad`: `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`
- `tokenizer`: `4aaf142ae42509d44653f1941e9add96deedae4c51557ae33cca1a96b83c42e4`

## Limitations and privacy

Official hardware/build flags are unknown; the page-era runtime is a proxy; bootstrap intervals have only 3–5 measured runs; sampler and thread probes are descriptive. Qwen GPU/vLLM concurrency throughput is intentionally excluded because it is not a single-stream M4 CPU latency baseline.

No transcript, reference text, audio, model, raw log, credential, token, cookie, or local absolute path is published.
