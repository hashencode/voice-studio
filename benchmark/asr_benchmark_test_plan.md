# Paraformer ASR Benchmark Test Plan

This file defines the repeatable mobile benchmark standard. The shipped route is standard recording, Silero VAD segmentation, and offline Paraformer recognition. Live VAD profiles are isolated historical/future-PC research inputs and are excluded from mobile smoke and release validation.

Physical-device validation is required before changing production defaults. Emulator results are screening evidence.

The 494-case regular standard below is the convergence and release-validation target. It is not the first-pass tuning entry point. Use the fast exploration path first, then spend full validation time only on candidates that survive the smaller gates.

Execution reliability and thermal safety are mandatory for all plans:

- If a run writes `*-failed-batches.tsv` entries, rerun each failed batch before moving to the next phase.
- If the same batch fails twice or a run is marked stale repeatedly, pause and do a controlled recovery (ADB reconnect, free local/temp files used by the runner, then relaunch).
- On physical device runs, check temperature before each stage and every 2 focused/validation batches. Pause if temperature is near or above the throttle threshold, cool down for 10–20 minutes, then resume.
- Prefer short-path validation first (Smoke → single-audio screening/focused) and only scale to longer runs after each stage passes.

## Regular Test Standard

| Part | Source | Profiles | Audio cases | Test cases | Purpose |
| --- | --- | ---: | ---: | ---: | --- |
| Smoke | `benchmark/asr_benchmark_profiles.json` default profile | 1 | 2 | 2 | Verify assets, runner, model loading, standard VAD, and report generation. |
| Focused | `generate_asr_profile_matrix.py --preset focused` on `asr-validation-manifest.json` | 96 | 5 | 480 | Main standard VAD micro-sweep around the current stable region. |
| Length / release validation | selected standard VAD profile on `asr-length-decision-manifest.json` | 1 | 12 | 12 | Validate selected behavior across complete-audio lengths. |
| Total | - | - | - | 494 | Normal mobile benchmark standard. |

Optional search layers:

| Layer | Source | Profiles | Default zh+en rows | Purpose |
| --- | --- | ---: | ---: | --- |
| Screening | `generate_asr_profile_matrix.py --preset screening` | 10 | 20 | One-factor VAD sanity sweep when focused results need a quick orientation check. |
| Coarse | `generate_asr_profile_matrix.py --preset coarse` | 160 | 320 | Wider VAD sweep after focused evidence points to a region. |
| Full | `generate_asr_profile_matrix.py --preset full` | 630 | 1260 | Backup deep-search layer. Do not run as the normal full suite. |

Generated matrices, raw results, and temporary selected-profile files stay under `build/asr_benchmark/` and are not committed.

## S2 Speech Enhancement Gate

Speech enhancement is an isolated paired experiment until every preregistered gate in `audio/s2_noise_manifest.json` passes. Generate the five deterministic inputs with:

```bash
python3 benchmark/prepare_s2_noise_audio.py
```

For each `quiet_clean`, `steady_noise_5db`, `burst_noise_0db`, `near_talk`, and `far_talk_5db` case, run the same production Paraformer/VAD configuration first on the generated input and then on GTCRN output. The original WAV remains byte-identical. Record raw/enhanced CER, timestamp P95, enhancement and combined RTF, Java/native peak-memory deltas, battery/thermal observations, device class, model hash, and output hash.

The initial physical GTCRN API/ABI smoke is not an accuracy gate. Promotion additionally requires every manifest threshold, both low- and mid-class physical-device runs, and no thermal throttling. GTCRN is noise suppression, not acoustic echo cancellation; it cannot satisfy an AEC claim. Until the complete paired report passes, `enhancement.verified`, `denoiseReady`, the request default, and product settings remain false.

## Fast Exploration Path

Use this path before the regular focused run when tuning standard offline VAD. It keeps Chinese and English separate and uses one representative audio case per language first.

| Step | Device | Input | Output | Gate |
| --- | --- | --- | --- | --- |
| 1. Static validation | local | Python/JSON scripts | no syntax errors | Profile generation and report scripts compile. |
| 2. Smoke | physical preferred, emulator acceptable | `standard_vad_silero_warm_t2` on core `zh`/`en` | one result JSON | 2 test cases complete with zero failures. |
| 3. Single-audio screening | physical preferred | `--preset screening`, run once with one Chinese audio case and once with one English audio case | two small result JSON files | Identify direction for threshold, min silence, max speech, and recognizer threads. |
| 4. Single-audio focused | physical preferred | `--preset focused`, still one Chinese case and one English case | up to 192 focused rows | Run only if screening shows a non-default direction or the default is not clearly best. |
| 5. Candidate selection | local | screening/focused results | selected profile JSON | Keep at most 3 standard VAD profiles per language/model. |
| 6. Candidate validation | physical or stable emulator | selected standard VAD profiles on the 5-case validation manifest | selected result JSON/report | Candidate must improve accuracy or tie accuracy while improving RTF. |
| 7. Release validation | physical | final standard VAD on length manifest | length result JSON/report | Required before changing mobile production defaults. |

Reliability continuation notes for Fast Exploration:

- A Stage passes only after all failed batches in that stage have been re-run successfully.
- If a stage has over 5% failed batches after reruns, stop and run recovery before continuing.

Physical-device thermal checkpoints:

- Pre-check before each workflow step: run `adb shell dumpsys battery | rg -i "temperature"` (if present, keep below ~420). Also run `adb shell cmd battery` on OEM builds that expose thermal warnings.
- Mid-run checkpoint: pause every 2 focused/validation batches and read temperature once.
- If temperature is high or throttling appears, stop the next run and cool down 10–20 minutes.
- Post-check after run: append logs and timestamped temperature entries in `build/asr_benchmark/logs/` for incident tracing.

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

When using generated validation audio, also pass:

```bash
BENCHMARK_MANIFEST_FILE="$PWD/build/asr_benchmark/diagnostics/asr-validation-manifest.json" \
BENCHMARK_AUDIO_ROOT="$PWD/build/asr_benchmark/validation_audio"
```

Useful single-audio validation IDs are `zh`, `zh_validation_aishell_raw1`, `en`, `en_official_0`, and `en_official_1`.

## Standard Workflow

Use this after the fast exploration path has identified candidates, or when running the formal benchmark standard without active tuning.

| Step | Device | Input | Output | Gate |
| --- | --- | --- | --- | --- |
| 1. Static validation | local | Python/JSON scripts | no syntax errors | Run before using device time. |
| 2. Smoke | emulator or physical | `standard_vad_silero_warm_t2` on core `zh`/`en` | one result JSON | 2 test cases complete with zero failures. |
| 3. Validation audio | local | `prepare_asr_validation_audio.py --mode all` | generated manifests/audio | Every scored audio case has reference text. |
| 4. Focused micro-sweep | emulator | `--preset focused` on the 5-case validation manifest | focused result JSON/TSV | 480 test cases complete; no recurring failures. |
| 5. Candidate selection | local | focused results | selected profile JSON | Top profiles selected per language/model. |
| 6. Neighbor sweep | emulator, conditional | selected profiles plus full matrix neighbors | follow-up profile JSON/results | Run only if a candidate clears improvement thresholds. |
| 7. Length / release validation | emulator or physical | selected standard VAD profile on the 12-case length manifest | length result JSON/report | 12 test cases complete; no length-specific regression. |
| 8. Physical rerun | physical device | selected finalists | physical result JSON/report | Required before production defaults change. |
| 9. Deep search | stable emulator or physical, optional | `coarse` or `full` batches | additional evidence | Only when focused evidence is inconclusive or a model/VAD/device change resets the search space. |

## Live VAD Experiment Boundary

The workflow above is the complete mobile production benchmark standard. Live VAD profiles are not counted in the 494 regular cases. They remain debug-only historical/future-PC research inputs, require explicit profile IDs, and cannot be promoted into the mobile product from this benchmark.

Standard VAD and `live_vad` benchmark routes share the same Silero VAD model, VAD parameter names, and Paraformer recognizer. With the default `liveFrameMs=100`, `live_vad` uses the same effective input cadence as the standard route's 100 ms VAD chunking. Therefore, broad VAD parameter search should run on the standard route first. Reuse those results to choose `live_vad` candidates instead of replaying the full standard matrix on the live route.

`live_vad` retests should focus on:

- Default `live_vad_paced` behavior.
- The top standard VAD candidates per language/model.
- One low-threshold candidate if it was competitive in standard results.
- One long-`maxSpeechDurationSec` candidate if it was competitive in standard results.

For `live_vad`, accuracy alone is not enough. Also review `firstSegmentResultWallMs`, `p95BoundaryLatencyMs`, `p95PaceLagMs`, `liveProcessingWallMs`, `segmentCount`, and empty segment counts.

The research path must not restore RMS or Live VAD mobile production code. Any user-visible realtime route requires a separate PC product plan.

## Focused Matrix

The focused sweep is the default optimization step:

| Parameter | Values |
| --- | --- |
| `threshold` | `0.15`, `0.20`, `0.25` |
| `minSilenceDurationSec` | `0.20`, `0.25`, `0.30`, `0.35` |
| `maxSpeechDurationSec` | `4.0`, `5.0`, `6.0`, `8.0` |
| recognizer `numThreads` | `2`, `4` |
| fixed `minSpeechDurationSec` | `0.25` |
| fixed VAD `numThreads` | `1` |

Total: `3 * 4 * 4 * 2 = 96` profiles. On the 5-case validation manifest, this is `480` focused test cases.

Single-audio focused is the first focused gate during tuning. Run the same 96 profiles once for a representative Chinese audio case and once for a representative English audio case before spending device time on all 5 validation cases. Continue to the 5-case focused run only if a candidate beats the default or the language-specific result is ambiguous.

Continue sweeping only when:

- CER/WER improves by at least `0.5%` absolute against the prior winner for the same language/model.
- Or CER/WER is tied within `0.1%` absolute and operation RTF improves by at least `10%`.
- The improvement holds on more than one validation case or is confirmed on a physical device.

## Candidate Rerun

Candidate selection should keep the rerun set small:

- Lowest CER/WER per language/model.
- Best RTF among profiles tied within `0.1%` absolute error rate.
- Most stable segmentation among competitive profiles, using `segmentCount`, `emptySegmentCount`, and `p95SegmentDecodeWallMs`.

Keep at most 3 standard VAD profiles per language/model before live replay. Add nearest neighbors only after one of those candidates clears the improvement gates.

Create a physical rerun file:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-file build/asr_benchmark/results/<emulator-run>.json \
  --output build/asr_benchmark/diagnostics/paraformer-physical-rerun.json
```

Run on a physical device:

```bash
BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/diagnostics/paraformer-physical-rerun.json" \
  DEVICE_ID="<physical-device-serial>" \
  ASR_BENCHMARK_TIMEOUT_SECONDS=10800 \
  ./benchmark/run_asr_benchmark.sh
```

Add nearest neighbors for another emulator focused sweep:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-list-tsv build/asr_benchmark/logs/<run-id>-results.tsv \
  --neighbor-source build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --neighbors-per-profile 2 \
  --improvement-baseline-profile-id "<prior-winning-profile-id>" \
  --output build/asr_benchmark/diagnostics/paraformer-focused-neighbors.json
```

## Current Production Default

| Field | Value |
| --- | --- |
| route | standard VAD segmented offline |
| `threshold` | `0.15` |
| `minSilenceDurationSec` | `0.20` |
| `minSpeechDurationSec` | `0.25` |
| `maxSpeechDurationSec` | `5.0` |
| recognizer `numThreads` | `4` |
| VAD `numThreads` | `1` |

## Isolated Live VAD Research Reference

| Field | Value |
| --- | --- |
| route | `live_vad` |
| `threshold` | `0.15` |
| `minSilenceDurationSec` | `0.25` |
| `minSpeechDurationSec` | `0.25` |
| `maxSpeechDurationSec` | `5.0` |
| recognizer `numThreads` | `4` |
| VAD `numThreads` | `1` |
| `liveFrameMs` | `100` |
| `liveRealtimePace` | `true` |

This table is retained only to reproduce historical experiments. It is not a mobile default, smoke profile, release profile, or product capability.

## Additional Sweep Ideas

After the focused grid above, the next useful local parameters are:

| Parameter | Suggested values | Why |
| --- | --- | --- |
| `minSpeechDurationSec` | `0.15`, `0.20`, `0.25`, `0.30` | Can recover short English words or Chinese particles when VAD is too strict. |
| VAD `numThreads` | `1`, `2` | Usually less important than recognizer threads, but worth checking on physical devices. |
| recognizer `numThreads` | `1`, `2`, `3`, `4` | Some phones throttle or regress at 4 threads. |
| `threshold` fine steps | around the winner, step `0.025` | Use only after a stable winner is found at `0.15/0.20/0.25`. |
| `minSilenceDurationSec` fine steps | around the winner, step `0.05s` | Controls split/merge behavior and punctuation-like pauses. |

Do not add broad factors until the focused and physical-device results show a concrete reason.
