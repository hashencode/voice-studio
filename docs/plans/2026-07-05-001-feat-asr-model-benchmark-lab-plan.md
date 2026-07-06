---
title: feat: Add ASR Model Benchmark Lab
type: feat
status: active
date: 2026-07-05
---

# feat: Add ASR Model Benchmark Lab

## Overview

Add a local Android benchmark path for comparing on-device ASR models in this Flutter app. The first iteration tests single-language Chinese and English audio on Android emulator, then reuses the same workflow on Android devices. It does not change production UI, default recording behavior, or model selection UX.

## Problem Frame

The app currently has a Paraformer-based Sherpa offline transcription path and a VAD-segmented near-realtime path. We need reproducible evidence before deciding which open-source model should power future mobile transcription. The benchmark must compare recognized text quality, offline latency, segmented-offline latency, and device pressure using the same audio and reference text per language.

## Requirements Trace

- R1. Create a new branch and keep the experiment isolated from current production behavior.
- R2. Compare only single-language Chinese and English audio for now; do not include mixed-language test cases.
- R3. Include the current Paraformer baseline and the named sherpa-onnx pretrained models below.
- R4. Support two execution modes per eligible model and language: whole-file offline and segmented offline simulating realtime.
- R5. Collect accuracy, latency, RTF, model size, memory, CPU-time, failure, and empty-result metrics.
- R6. Run first on Android emulator; keep the same runner usable for later real-device validation.
- R7. Keep model weights and long test audio outside git; commit only tooling, manifests, and reproducible instructions.

## Scope Boundaries

- No product UI changes.
- No iOS simulator work; this repository is Android-first and has no `ios/` directory.
- No mixed-language audio in this phase.
- No true streaming recognizer integration in this phase; "realtime" means deterministic segmentation plus offline decode per segment.
- No benchmark-based production recommendation changes yet.

## Context & Research

### Relevant Code and Patterns

- `android/app/src/main/kotlin/com/voice2text/app/transcription/RealSherpaTranscriptionEngine.kt` already creates a Sherpa `OfflineRecognizer` and reads wav files through `WaveReader`.
- `android/app/src/main/kotlin/com/voice2text/app/transcription/TranscriptionModelRegistry.kt` currently exposes only the production Paraformer model ids.
- `android/app/src/main/kotlin/com/voice2text/app/realtime/RealtimeAsrProcessor.kt` already implements the production "segmented offline" realtime posture for microphone frames.
- `android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt` is the existing MethodChannel entry point.
- `tool/run_android_smoke.sh` and `tool/check_transcribe_log.sh` show the existing adb-driven testing style.
- `docs/architecture/dual-transcription-pipeline.md` explicitly calls for fixed test-audio benchmark evidence before realtime recommendation.

### External References

- sherpa-onnx Offline Paraformer docs list `sherpa-onnx-paraformer-zh-int8-2025-10-07`, `sherpa-onnx-paraformer-en-2024-03-09`, and older bilingual variants.
- sherpa-onnx SenseVoice docs list `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`.
- sherpa-onnx Moonshine v2 docs list `sherpa-onnx-moonshine-base-zh-quantized-2026-02-27`, `sherpa-onnx-moonshine-base-en-quantized-2026-02-27`, and `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27`.
- sherpa-onnx FireRedASR docs list `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` and `sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26`.
- AISHELL-style or OpenSLR Chinese data and TED-LIUM or LibriSpeech English data can supply longer audio plus reference text; the implementation should accept local wav/reference paths instead of hard-coding a specific large corpus.

## Key Technical Decisions

- Use a benchmark-only model manifest instead of extending production model settings. This avoids accidentally exposing unvalidated models in the app UI.
- Push extracted models and audio into app-private files for emulator runs. This avoids multi-GB APK assets and keeps weights out of git.
- Trigger benchmark execution through a debug-only Android Activity. This reuses the app process and JNI libraries without adding production UI or a production MethodChannel API.
- Use whole-file offline and fixed-window segmented offline first. VAD-specific segmentation can be added later once the base comparison is stable.
- Compute CER for Chinese and WER for English in the native runner from the same normalized outputs written to JSON.

## Model Matrix

| Language | Model id | Pretrained model |
|---|---|---|
| Chinese | `paraformer-zh-2025-10-07` | `sherpa-onnx-paraformer-zh-int8-2025-10-07` |
| Chinese | `sensevoice-zh-en-ja-ko-yue-2025-09-09` | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09` |
| Chinese | `moonshine-base-zh-2026-02-27` | `sherpa-onnx-moonshine-base-zh-quantized-2026-02-27` |
| Chinese | `fire-red-asr2-ctc-zh-en-2026-02-25` | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` |
| Chinese | `fire-red-asr2-aed-zh-en-2026-02-26` | `sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26` |
| English | `paraformer-en-2024-03-09` | `sherpa-onnx-paraformer-en-2024-03-09` |
| English | `sensevoice-zh-en-ja-ko-yue-2025-09-09` | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09` |
| English | `moonshine-base-en-2026-02-27` | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27` |
| English | `moonshine-tiny-en-2026-02-27` | `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27` |
| English | `fire-red-asr2-ctc-zh-en-2026-02-25` | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25` |
| English | `fire-red-asr2-aed-zh-en-2026-02-26` | `sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26` |

## Open Questions

### Resolved During Planning

- Should mixed-language audio be included now? No. The first benchmark compares Chinese and English single-language behavior only.
- Should Moonshine v1 be tested? No. Only Moonshine v2 models are in scope.
- Should model binaries be committed? No. They are local test artifacts.

### Deferred to Implementation

- Exact corpus samples and durations: select local wav/reference files once downloads are available.
- Final segmented window length: start deterministic and configurable; tune after emulator smoke results.
- Whether FireRedASR AED can run acceptably on emulator memory: measure and report instead of assuming.

## Output Structure

    benchmark/
      asr_benchmark_manifest.json
      audio_manifest.md
      download_asr_benchmark_models.sh
      install_asr_benchmark_assets.sh
      run_asr_benchmark.sh
      android/src/debug/kotlin/com/voice2text/app/benchmark/
        AsrBenchmarkRunner.kt
        AsrBenchmarkTypes.kt

## Implementation Units

- [x] **Unit 1: Benchmark manifests and local asset scripts**

**Goal:** Define the model matrix, expected local audio layout, and host scripts for downloading/extracting models and copying benchmark assets into the installed app.

**Requirements:** R2, R3, R6, R7

**Dependencies:** None

**Files:**
- Create: `benchmark/asr_benchmark_manifest.json`
- Create: `benchmark/audio_manifest.md`
- Create: `benchmark/download_asr_benchmark_models.sh`
- Create: `benchmark/install_asr_benchmark_assets.sh`
- Create: `benchmark/run_asr_benchmark.sh`

**Approach:**
- Store model metadata as data: id, display name, language, family, download URL, extracted directory, required files, and default thread count.
- Store benchmark plan expectations separately from production assets.
- Scripts should use `build/asr_benchmark/` for local artifacts and app-private `files/asr_benchmark/` for emulator/device artifacts.
- Scripts should fail clearly when required audio/reference files are missing.

**Patterns to follow:**
- Existing shell style in `tool/run_android_smoke.sh`.
- Existing command documentation style in `README.md`.

**Test scenarios:**
- Happy path: manifest contains only Chinese and English entries, no mixed-language case.
- Happy path: install script copies a small sample file into app-private storage using `run-as`.
- Error path: scripts fail with a clear message when the device id is missing or adb cannot reach the device.
- Error path: scripts fail with a clear message when an expected model file is missing after extraction.

**Verification:**
- A developer can prepare local model directories without editing production asset declarations.

- [x] **Unit 2: Native benchmark recognizer factory**

**Goal:** Add benchmark-only Kotlin code that creates Sherpa offline recognizers for Paraformer, SenseVoice, Moonshine v2, and FireRedASR v2 model layouts.

**Requirements:** R3, R4

**Dependencies:** Unit 1

**Files:**
- Create: `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkTypes.kt`
- Create: `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkRunner.kt`
- Modify: `android/app/build.gradle.kts`

**Approach:**
- Parse the app-private benchmark manifest with `org.json`.
- Resolve all model paths relative to `context.filesDir/asr_benchmark`.
- Use `OfflineParaformerModelConfig`, `OfflineSenseVoiceModelConfig`, `OfflineMoonshineModelConfig`, `OfflineFireRedAsrCtcModelConfig`, and `OfflineFireRedAsrModelConfig`.
- Keep benchmark code under `benchmark/` and include it through the debug source set so production behavior remains unchanged.

**Patterns to follow:**
- `RealSherpaTranscriptionEngine.kt` recognizer lifecycle and release handling.
- Debug-only `Activity` launch pattern.

**Test scenarios:**
- Happy path: each model family maps to the correct Sherpa config fields.
- Error path: missing model files are reported before recognizer creation.
- Error path: unknown model family fails with model id and family in the error.
- Integration: existing `transcribe` MethodChannel method remains unchanged.

**Verification:**
- The debug APK compiles with all benchmark model config classes from the bundled AAR.

- [x] **Unit 3: Benchmark execution and metrics**

**Goal:** Run whole-file and segmented-offline inference, compute metrics, and write result JSON.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 2

**Files:**
- Modify: `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkRunner.kt`
- Create: `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkActivity.kt`
- Modify: `android/app/src/debug/AndroidManifest.xml`

**Approach:**
- Use `WaveReader` for benchmark wav files.
- Measure recognizer load time, decode time, wall time, thread CPU time, Java heap, native heap, and model directory size.
- For Chinese, normalize and compute CER; for English, normalize and compute WER.
- For segmented mode, split samples into configurable fixed windows and concatenate decoded segments in order.
- Write one JSON report under `files/asr_benchmark/results/` and expose completion through `files/asr_benchmark/status.json`.

**Patterns to follow:**
- `RealtimeAudioFileWriter.kt` and `RealtimeAsrProcessor.kt` for segment-oriented thinking.
- Existing MethodChannel invocation style in `lib/features/transcription/service/android_transcription_service.dart`.

**Test scenarios:**
- Happy path: a known reference and hypothesis pair returns zero CER/WER.
- Edge case: empty hypothesis produces full error rate rather than divide-by-zero.
- Edge case: segmented mode handles final segments shorter than the configured window.
- Error path: missing reference text records a runnable benchmark result with accuracy fields omitted.
- Integration: integration test prints a stable result marker that scripts can parse.

**Verification:**
- Running the integration test on emulator produces a result JSON file for at least one installed model/audio pair.

- [x] **Unit 4: Host runner and documentation**

**Goal:** Make the emulator run reproducible from one command and document how to provide Chinese/English audio.

**Requirements:** R1, R2, R6, R7

**Dependencies:** Units 1-3

**Files:**
- Modify: `README.md`
- Modify: `benchmark/run_asr_benchmark.sh`
- Modify: `benchmark/audio_manifest.md`

**Approach:**
- Document local paths for `zh.wav`, `zh.txt`, `en.wav`, and `en.txt`.
- Make the runner install the debug APK, copy assets, start the debug benchmark Activity, poll status, and pull result JSON back to `build/asr_benchmark/results/`.
- State that emulator pressure metrics are preliminary and real-device runs are required before choosing a production default.

**Patterns to follow:**
- Existing README command list and Android smoke workflow.

**Test scenarios:**
- Happy path: runner emits the pulled result path after integration test success.
- Error path: missing `zh.wav` or `en.wav` stops before launching the test.
- Edge case: runner can target an explicit device id.

**Verification:**
- Documentation and scripts are sufficient to rerun the same benchmark locally without changing app UI.

- [x] **Unit 5: Verification**

**Goal:** Validate the benchmark tooling without requiring large models to be present in git.

**Requirements:** R1, R6, R7

**Dependencies:** Units 1-4

**Files:**
- Modify: `tool/dev_check.sh` only if needed for non-device validation.

**Approach:**
- Run the normal project check.
- Run a debug APK build to compile Kotlin benchmark code.
- If emulator and local model/audio artifacts are available, run one smoke benchmark; otherwise document the exact missing artifact.

**Patterns to follow:**
- `./tool/dev_check.sh` remains the normal non-device gate.

**Test scenarios:**
- Happy path: `./tool/dev_check.sh` still passes.
- Happy path: `flutter build apk --debug` catches Kotlin compile errors.
- Error path: benchmark runner reports missing local artifacts instead of silently passing.

**Verification:**
- The branch contains a plan, benchmark tooling, and compile-checked native code.

## System-Wide Impact

- **Interaction graph:** Adds one benchmark-only debug Activity. Existing recorder/transcribe MethodChannel methods remain unchanged.
- **Error propagation:** Benchmark failures return structured MethodChannel errors and write no successful result file.
- **State lifecycle risks:** App-private benchmark files can be large; scripts should copy only requested assets and support cleanup by deleting `files/asr_benchmark`.
- **API surface parity:** Dart production services do not call benchmark code.
- **Integration coverage:** Integration test exercises Flutter MethodChannel to Android native to Sherpa JNI.
- **Unchanged invariants:** Standard recording, realtime recording, persisted jobs, settings, and existing model descriptors remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Large model downloads are slow and may exhaust emulator storage | Keep downloads local, copy only selected models, and fail with size/path diagnostics. |
| FireRedASR AED may exceed emulator memory | Treat emulator result as measurement; do not require it to pass for normal dev checks. |
| Fixed-window segmentation can cut words | Record it as deterministic simulated realtime; VAD segmentation can be a later benchmark mode. |
| Accuracy comparisons depend on text normalization | Store normalized reference/hypothesis in JSON so normalization is auditable. |
| Native benchmark runner accidentally becomes production API | Keep it behind the debug Activity and shell scripts only. |

## Documentation / Operational Notes

- Model weights and corpus audio remain local artifacts under `build/asr_benchmark/`.
- Emulator results are suitable for functional comparison and rough pressure signals only.
- Real-device validation should reuse the same scripts with an explicit physical device id.

## Sources & References

- Related architecture: `docs/architecture/dual-transcription-pipeline.md`
- Existing plan: `docs/plans/2026-07-04-001-feat-dual-transcription-pipeline-plan.md`
- Existing native offline recognizer: `android/app/src/main/kotlin/com/voice2text/app/transcription/RealSherpaTranscriptionEngine.kt`
- External docs: `https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html`
- External docs: `https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html`
- External docs: `https://k2-fsa.github.io/sherpa/onnx/moonshine/models-v2.html`
- External docs: `https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html`
