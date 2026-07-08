# ASR Benchmark

This folder contains the Paraformer ASR benchmark lab. The shipped production route is standard recording followed by Silero VAD segmentation and offline Paraformer recognition. The benchmark standard also tracks `live_vad_paced` as the realtime production-candidate route.

## Storage Policy

- Commit benchmark code, manifests, fixed audio fixtures, small reports, and docs.
- Do not commit downloaded model archives, extracted model files, raw run outputs, or generated matrices.
- Local cache root: `build/asr_benchmark/`.

## Layout

- `asr_benchmark_manifest.json`: model matrix, VAD defaults, and archive URLs.
- `asr_benchmark_profiles.json`: short smoke and realtime-candidate profiles.
- `audio/`: committed Chinese and English benchmark wav/text fixtures.
- `android/src/debug/kotlin/`: debug-only Android benchmark Activity and runner.
- `prepare_asr_benchmark_audio.sh`: copies committed audio fixtures to `build/asr_benchmark/audio`.
- `prepare_asr_validation_audio.py`: prepares generated validation and length-validation manifests under `build/asr_benchmark/`.
- `download_asr_benchmark_models.sh`: downloads and extracts selected models into `build/asr_benchmark/models`.
- `run_asr_benchmark.sh`: builds the debug APK, installs assets, runs the benchmark Activity, and pulls JSON results.
- `generate_asr_profile_matrix.py`: generates repeatable VAD tuning matrices.
- `select_asr_benchmark_profiles.py`: selects top emulator profiles for focused or physical-device reruns.
- `generate_asr_benchmark_visual_report.py`: regenerates summary JSON and the single-route HTML report.
- `asr_benchmark_test_plan.md`: regular three-part benchmark standard plus optional deep-search definitions.

## Quick Start

```bash
MODEL_IDS="paraformer-zh-2025-10-07 paraformer-en-2024-03-09" \
  PROFILE_IDS="standard_vad_silero_warm_t2" \
  ./benchmark/run_asr_benchmark.sh

./benchmark/generate_asr_benchmark_visual_report.py
open benchmark/asr_benchmark_visual_report_2026-07-05.html
```

`run_asr_benchmark.sh` automatically uses the only online Android device from `adb devices`. If more than one Android device is online, pass a serial with `DEVICE_ID=<serial>` or as the first script argument.

## Models

```bash
./benchmark/download_asr_benchmark_models.sh \
  paraformer-zh-2025-10-07 \
  paraformer-en-2024-03-09
```

Current pretrained model IDs:

| ID | Pretrained model |
| --- | --- |
| `paraformer-zh-2025-10-07` | `sherpa-onnx-paraformer-zh-int8-2025-10-07` |
| `paraformer-en-2024-03-09` | `sherpa-onnx-paraformer-en-2024-03-09` |

## Parameter Profiles

Tracked profiles:

| Profile | Route | Parameters |
| --- | --- | --- |
| `standard_vad_silero_warm_t2` | standard VAD | Formal profile. Threshold `0.15`, minSilence `0.20s`, minSpeech `0.25s`, maxSpeech `5.0s`, recognizer threads `4`. |
| `live_vad_silero_paced_t2_f100` | live VAD paced replay | Formal realtime-candidate profile. Sleeps to match recorded audio time, frame `100ms`, threshold `0.15`, minSilence `0.25s`, maxSpeech `5.0s`, recognizer threads `4`. |
| `live_vad_silero_replay_t2_f100` | live VAD fast replay | Debug-only diagnostic profile. Feeds 100ms PCM frames as fast as the device can process them; not counted in the formal test standard. |

Generate repeatable matrices:

```bash
./benchmark/generate_asr_profile_matrix.py \
  --preset focused \
  --output build/asr_benchmark/profile_matrices/paraformer-focused-grid.json \
  --batch-size 20

./benchmark/generate_asr_profile_matrix.py \
  --preset full \
  --output build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --batch-size 20
```

Regular test standard:

| Part | Profiles | Audio set | Test cases | Use |
| --- | ---: | --- | ---: | --- |
| Smoke | 2 | Core `zh` + `en` | 4 | Verify runner, assets, model loading, standard VAD, and `live_vad_paced`. |
| Focused | 96 | Validation manifest, 5 cases | 480 | Main standard VAD micro-sweep: `threshold=[0.15,0.20,0.25]`, `minSilence=[0.20,0.25,0.30,0.35]`, `maxSpeech=[4,5,6,8]`, `threads=[2,4]`. |
| Length / release validation | 2 | Length manifest, 12 cases | 24 | Validate selected standard VAD and `live_vad_paced` behavior across complete-audio lengths. |
| Total | - | - | 508 | Normal benchmark standard. |

The 508-case standard is the convergence and release-validation target. For active tuning, use the fast exploration path first so device time is spent on candidates instead of broad retesting.

Optional search layers:

| Preset | Profiles | Default zh+en rows | Use |
| --- | ---: | ---: | --- |
| `screening` | 10 | 20 | One-factor VAD sanity sweep around the default. Run one Chinese and one English audio case first during exploration. |
| `coarse` | 160 | 320 | Wider VAD sweep after focused results show a promising direction. |
| `full` | 630 | 1260 | Backup deep-search layer. Do not run as the normal full suite. |

## Fast Exploration Workflow

Use this workflow when tuning VAD or evaluating realtime accuracy. It separates Chinese and English early, runs one representative audio case per language before the 5-case validation set, and promotes only a small candidate set to `live_vad`.

1. Run smoke with `standard_vad_silero_warm_t2` and `live_vad_silero_paced_t2_f100` to verify the benchmark path.
2. Generate a `screening` matrix and run one Chinese audio case, then one English audio case.
3. If screening shows a non-default direction, generate a `focused` matrix and run one Chinese audio case plus one English audio case.
4. Select at most 3 standard VAD candidates per language/model: lowest error rate, fastest tied-accuracy profile, and most stable segmentation.
5. Validate selected standard VAD candidates on the 5-case validation manifest.
6. Convert only selected candidates to `live_vad_paced` profiles. Retest default live VAD, the selected candidates, and one competitive low-threshold or long-segment boundary case if present.
7. Run length / release validation for the final standard VAD candidate and `live_vad_paced`.
8. Rerun selected finalists on a physical device before changing production defaults.

Example single-audio screening:

```bash
./benchmark/generate_asr_profile_matrix.py \
  --preset screening \
  --output build/asr_benchmark/profile_matrices/paraformer-screening-grid.json

BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/profile_matrices/paraformer-screening-grid.json" \
  MODEL_IDS="paraformer-zh-2025-10-07" \
  AUDIO_CASES="zh" \
  DEVICE_ID="<physical-device-serial>" \
  ./benchmark/run_asr_benchmark.sh

BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/profile_matrices/paraformer-screening-grid.json" \
  MODEL_IDS="paraformer-en-2024-03-09" \
  AUDIO_CASES="en" \
  DEVICE_ID="<physical-device-serial>" \
  ./benchmark/run_asr_benchmark.sh
```

When running generated validation audio, also pass:

```bash
BENCHMARK_MANIFEST_FILE="$PWD/build/asr_benchmark/diagnostics/asr-validation-manifest.json" \
BENCHMARK_AUDIO_ROOT="$PWD/build/asr_benchmark/validation_audio"
```

Useful single-audio validation IDs are `zh`, `zh_validation_aishell_raw1`, `en`, `en_official_0`, and `en_official_1`.

## Standard Workflow

Use this workflow after fast exploration has identified candidates, or when running the formal benchmark standard without active tuning.

1. Run smoke with `standard_vad_silero_warm_t2` and `live_vad_silero_paced_t2_f100` to verify the benchmark path.
2. Prepare validation audio with `./benchmark/prepare_asr_validation_audio.py --mode all`.
3. Run the `focused` standard VAD micro-sweep on the 5-case validation manifest.
4. Select candidates with `select_asr_benchmark_profiles.py`.
5. If a selected candidate clearly improves accuracy or keeps accuracy tied while improving RTF, run another neighbor-focused sweep from `paraformer-full-grid.json`.
6. Run length / release validation for selected standard VAD and `live_vad_paced` profiles.
7. Rerun selected finalists on a physical device before changing production defaults.
8. Use `coarse` or `full` only as optional deep-search layers when the focused results are inconclusive or a model/VAD/device change resets the search space.

Create a physical rerun profile file:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-file build/asr_benchmark/results/<emulator-run>.json \
  --output build/asr_benchmark/diagnostics/paraformer-physical-rerun.json
```

Run it on a physical device:

```bash
BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/diagnostics/paraformer-physical-rerun.json" \
  DEVICE_ID="<physical-device-serial>" \
  ASR_BENCHMARK_TIMEOUT_SECONDS=10800 \
  ./benchmark/run_asr_benchmark.sh
```

For a focused emulator follow-up:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-list-tsv build/asr_benchmark/logs/<run-id>-results.tsv \
  --neighbor-source build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --neighbors-per-profile 2 \
  --improvement-baseline-profile-id "<prior-winning-profile-id>" \
  --output build/asr_benchmark/diagnostics/paraformer-focused-neighbors.json
```

## Live VAD Experiment Boundary

`live_vad` is the only realtime direction worth re-testing. It remains a realtime production candidate until true microphone capture, lifecycle, recording-save, and UI event behavior are validated. The intended shape is `AudioRecord -> Silero VAD -> in-memory speech segment -> shared Paraformer recognizer -> benchmark/UI event`. It should not use fixed WAV polling, and it should not restore the old RMS MethodChannel/EventChannel production path.

The benchmark `standard` and `live_vad` routes share the same Silero VAD model, VAD parameters, and Paraformer recognizer. With the default `liveFrameMs=100`, `live_vad` uses the same effective input cadence as the standard route's 100 ms VAD chunking. Run broad VAD parameter search on the standard route first, then retest only selected candidates with `live_vad_paced`.

Relevant live VAD profiles:

- `live_vad_silero_paced_t2_f100` feeds frames while sleeping to match the audio timeline. It is counted in formal smoke and length / release validation.
- `live_vad_silero_replay_t2_f100` feeds wav samples as 100ms PCM frames as fast as the device can process them. It is debug-only and is not counted in the formal 508-case standard.

Promotion requires accuracy close enough to the standard VAD route, realtime-friendly first/final segment latency, no recording-save regression, and a clear advantage over the retired RMS baseline below. For live replay, review `firstSegmentResultWallMs`, `p95BoundaryLatencyMs`, `p95PaceLagMs`, `liveProcessingWallMs`, segment counts, and empty segment counts.

## Retired RMS Experiment

Realtime RMS is no longer production code and is no longer a benchmark route. The last useful experimental parameter record is kept only for reference:

| Field | Value |
| --- | --- |
| profile id | `realtime_rms_t4_f080_thr0420_min0320_end1000_max16000_pre0000` |
| frame | `80ms` |
| speech threshold | `420` |
| min speech | `320ms` |
| end silence | `1000ms` |
| max segment | `16000ms` |
| pre-roll | `0ms` |
| recognizer threads | `4` |

Use this only as historical context. New product and benchmark work should tune the standard VAD route first, then validate selected settings with `live_vad_paced`.
