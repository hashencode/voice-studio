# ASR Benchmark

This folder contains the ASR benchmark lab and generated reports. Benchmark code stays here so production Flutter and Android source paths remain focused on the app.

## Storage Policy

- Commit benchmark code, manifests, fixed audio fixtures, small reports, and docs.
- Do not commit downloaded model archives or extracted model files.
- Local cache root: `build/asr_benchmark/`.

Model download URLs live in `benchmark/asr_benchmark_manifest.json` under each model's `archiveUrl`. If a model is missing, the download script fetches it again.

## Layout

- `asr_benchmark_manifest.json`: model matrix, required files, and archive URLs.
- `asr_benchmark_profiles.json`: route-specific parameter profiles for Paraformer tuning.
- `audio/`: committed Chinese and English benchmark wav/text fixtures.
- `android/src/debug/kotlin/`: debug-only Android benchmark Activity and runner.
- `prepare_asr_benchmark_audio.sh`: copies committed audio fixtures to `build/asr_benchmark/audio`; set `REBUILD_FROM_SOURCES=1` only when intentionally rebuilding fixtures from public sources.
- `download_asr_benchmark_models.sh`: downloads and extracts selected models into `build/asr_benchmark/models`.
- `run_asr_benchmark.sh`: builds the debug APK, installs assets, runs the benchmark Activity, and pulls JSON results.
- `generate_asr_profile_matrix.py`: generates larger Paraformer tuning matrices under `build/asr_benchmark/profile_matrices`.
- `generate_asr_benchmark_visual_report.py`: regenerates summary JSON and the HTML report from local result JSON.
- `asr_benchmark_test_plan.md`: complete smoke/coarse/full matrix definition and reproduction commands.

## Quick Start

```bash
MODEL_IDS="paraformer-zh-2025-10-07 paraformer-en-2024-03-09" \
  PROFILE_IDS="standard_whole_warm_t2 standard_vad_silero_warm_t2 realtime_rms_warm_baseline_t2 realtime_silero_warm_default_t2" \
  DEVICE_ID=emulator-5554 \
  ./benchmark/run_asr_benchmark.sh
./benchmark/generate_asr_benchmark_visual_report.py
open benchmark/asr_benchmark_visual_report_2026-07-05.html
```

## Models

Download one or more models by ID:

```bash
./benchmark/download_asr_benchmark_models.sh paraformer-zh-2025-10-07
```

Without arguments, the script downloads every model in `asr_benchmark_manifest.json`.
After extraction, the script prunes each local model directory to the files declared in `requiredFiles`, so unused upstream files are not copied into benchmark staging or pushed to the device.

Current pretrained model IDs are:

| ID | Pretrained model |
| --- | --- |
| `paraformer-zh-2025-10-07` | `sherpa-onnx-paraformer-zh-int8-2025-10-07` |
| `paraformer-en-2024-03-09` | `sherpa-onnx-paraformer-en-2024-03-09` |

SenseVoice, Moonshine, and FireRedASR were measured during the initial investigation and then removed from the default matrix. Current benchmark work focuses on Paraformer tuning.

## Parameter Profiles

The comparison unit is now a parameter profile, not a model. Profiles live in `benchmark/asr_benchmark_profiles.json` and are staged to the device as `profiles.json`.

Default profile IDs are warm steady-state smoke profiles. They verify the benchmark flow and keep routine runs short; they are not the exhaustive tuning matrix.

| Profile | Route | Purpose |
| --- | --- | --- |
| `standard_whole_warm_t2` | standard | Whole-file offline recognition with a shared warm recognizer. |
| `standard_vad_silero_warm_t2` | standard | Silero VAD segmentation plus shared warm recognizer. |
| `realtime_rms_warm_baseline_t2` | realtime replay | Replays fixture audio through RMS segmentation, reusing the recognizer. |
| `realtime_silero_warm_default_t2` | realtime replay | Replays fixture audio through Silero segmentation, reusing the recognizer. |

Cold/current profiles are available but not run by default because model loading can dominate runtime:

```bash
PROFILE_IDS="standard_whole_cold_t2 realtime_rms_current_baseline_t2" \
  MODEL_IDS="paraformer-zh-2025-10-07 paraformer-en-2024-03-09" \
  DEVICE_ID=emulator-5554 \
  ./benchmark/run_asr_benchmark.sh
```

Use `BENCHMARK_PROFILES_FILE=/path/to/profiles.json` for a larger matrix. The installer filters staged profiles with `PROFILE_IDS`; if `PROFILE_IDS` is omitted, it uses `defaultProfileIds`.

Generate repeatable matrices:

```bash
./benchmark/generate_asr_profile_matrix.py \
  --preset coarse \
  --output build/asr_benchmark/profile_matrices/paraformer-coarse-grid.json \
  --batch-size 30

./benchmark/generate_asr_profile_matrix.py \
  --preset full \
  --output build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --batch-size 100
```

The complete layer definitions and batch guidance are in `benchmark/asr_benchmark_test_plan.md`.

Physical-device validation is not skipped by default. Use the physical serial from `adb devices` as `DEVICE_ID`; skip it only when the run explicitly documents that no real device is connected or that the run is emulator-only.

Current presets:

| Preset | Profiles | Expected result rows with zh+en | Use |
| --- | ---: | ---: | --- |
| `coarse` | 89 | 178 | Practical emulator sweep for the main interacting parameters. |
| `full` | 4969 | 9938 | Large full-factorial grid. Run in batches, preferably on stable hardware. |

Run the coarse matrix on an emulator:

```bash
BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/profile_matrices/paraformer-coarse-grid.json" \
  DEVICE_ID=emulator-5554 \
  ASR_BENCHMARK_TIMEOUT_SECONDS=10800 \
  ./benchmark/run_asr_benchmark.sh
```

## Audio Fixtures

The default audio files are committed so repeat runs do not need to search for public corpora or download large speech datasets:

| File | Purpose |
| --- | --- |
| `benchmark/audio/zh.wav` | Chinese long-form smoke audio, mono 16kHz wav. |
| `benchmark/audio/zh.txt` | Chinese reference transcript. |
| `benchmark/audio/en.wav` | English long-form smoke audio, mono 16kHz wav. |
| `benchmark/audio/en.txt` | English reference transcript. |

`run_asr_benchmark.sh` installs those files directly through `install_asr_benchmark_assets.sh`. `prepare_asr_benchmark_audio.sh` remains as a compatibility helper for copying them to `build/asr_benchmark/audio`.

## Modes

- `offline`: whole-file offline decode. Useful for short audio or high-memory device checks.
- `segmented_offline`: fixed-window chunks. Kept mainly for diagnosis.
- `vad_segmented_offline`: Silero VAD finds speech segments, then each segment is decoded offline. Use this for controlled model-to-model comparison. The default Silero settings follow sherpa-onnx's subtitle example: threshold `0.2`, min silence `0.25s`, min speech `0.25s`, max speech `5s`.

## Report Structure

`generate_asr_benchmark_visual_report.py` writes a two-tab HTML report:

- Standard route benchmark: whole-file and VAD-segmented offline profiles.
- Realtime route replay benchmark: fixture audio replayed as synthetic realtime frames, then segmented and decoded.

Each row records:

- `runClass=warm`: recognizer loaded once and warmed before measurement. Use this for parameter ranking.
- `runClass=cold`: recognizer load is part of the measured operation.
- `runClass=current`: approximates current business-route loading behavior, such as realtime per-segment recognizer load.

By default the report generator reads every result JSON under `build/asr_benchmark/results`. To generate a report for a single matrix run, pass the exact result file:

```bash
./benchmark/generate_asr_benchmark_visual_report.py \
  --result-file build/asr_benchmark/results/asr-benchmark-1783274555128.json
```

Bias controls to keep in mind:

- Randomize or rotate large profile run order when doing exhaustive sweeps.
- Separate warm/cold/current results; do not rank parameters on mixed load strategies.
- Treat simulator timing and memory as screening evidence only.
- Watch segment count, empty segments, p95 segment decode time, model-load time, queue/drop counts, and operation RTF together.
- Keep first-run warm-up, filesystem cache, Android background load, emulator CPU allocation, and thermal state in mind when comparing close results.
- Keep audio source, sample rate, normalization, reference text cleanup, and punctuation/case normalization fixed across profiles.
- The committed fixtures are stable but limited; add more fixtures before treating a profile as globally optimal.

## Ad-Hoc Manifests

The default manifest should stay focused on the repeatable model matrix. For one-off diagnostics, write a temporary manifest under `build/asr_benchmark/diagnostics/` and pass it through `BENCHMARK_MANIFEST_FILE`:

```bash
BENCHMARK_MANIFEST_FILE="$PWD/build/asr_benchmark/diagnostics/my_case.json" \
  BENCHMARK_AUDIO_ROOT="$PWD/build/asr_benchmark" \
  MODEL_IDS="paraformer-zh-2025-10-07" \
  AUDIO_CASES="my_audio_case" \
  PROFILE_IDS="my_profile_id" \
  DEVICE_ID=emulator-5554 \
  ./benchmark/run_asr_benchmark.sh
```

## Business-Route Benchmark Direction

The benchmark now has standard-route profiles and realtime replay profiles. For an even closer production check, keep adding route-level tests here instead of adding benchmark code to app feature folders:

- `business_standard_offline`: feed a fixed file through the same standard recording/transcribe path as the app.
- `business_realtime_replay`: replay PCM frames through the same realtime VAD and segment transcription path as the app.

Those route benchmarks should still write results to `build/asr_benchmark/results` and feed the same report generator.
